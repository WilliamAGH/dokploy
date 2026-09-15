import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	environments,
	projects,
} from "@dokploy/server/db/schema";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { IS_CLOUD } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";

export interface NetworkIpUsage {
	name: string;
	driver: string;
	subnet: string | null;
	containersInUse: number;
	capacity: number | null;
	percentUsed: number | null;
}

export interface ServerHealthResult {
	checkedAt: string;
	containers: {
		containerCount: number;
		serviceCount: number;
	};
	resources: {
		memTotalBytes: number;
		memUsedBytes: number;
		cpuCount: number;
	};
	inotify: {
		maxWatches: number;
		maxInstances: number;
		maxQueuedEvents: number;
		persisted: boolean;
		users: Array<{
			uid: number;
			username: string | null;
			currentInstances: number;
		}>;
		defaultUid: number;
		error?: string;
	};
	disk: {
		totalBytes: number;
		usedBytes: number;
	};
	dockerNetworks: {
		count: number;
		addressPools: unknown | null;
		/** Per-network IP utilization, including reserved networks like dokploy-network */
		usage: NetworkIpUsage[];
		/** Set when `usage` couldn't be read, so the UI can tell that apart from "no networks" */
		usageError?: string;
	};
	daemonErrors: string[];
	/** The window actually passed to `journalctl --since`, computed on the target machine's clock */
	daemonLogsWindow: { fromEpoch: number; toEpoch: number } | null;
	reservation: {
		memoryReservedBytes: number;
		cpuReservedNanoCpus: number;
		appCount: number;
		unsupportedComposeCount: number;
	} | null;
	error?: string;
}

interface RawHealthOutput {
	containerCount?: number | string;
	serviceCount?: number | string;
	memTotalBytes?: number | string;
	memUsedBytes?: number | string;
	cpuCount?: number | string;
	inotifyMaxWatches?: number | string;
	inotifyMaxInstances?: number | string;
	inotifyMaxQueuedEvents?: number | string;
	inotifyPersistedCount?: number | string;
	inotifyUsersBase64?: string;
	inotifyKnownUsersBase64?: string;
	inotifyDefaultUid?: number | string;
	inotifyExecutionUid?: number | string;
	inotifyErrorBase64?: string;
	diskTotalBytes?: number | string;
	diskUsedBytes?: number | string;
	networkCount?: number | string;
	daemonConfigBase64?: string;
	daemonErrorsBase64?: string;
	daemonLogsFromEpoch?: number | string;
	daemonLogsToEpoch?: number | string;
}

const toInt = (value: unknown): number => {
	const n = Number.parseInt(String(value ?? "0"), 10);
	return Number.isFinite(n) ? n : 0;
};

const b64Decode = (value?: string): string => {
	if (!value) return "";
	try {
		return Buffer.from(value, "base64").toString("utf-8");
	} catch {
		return "";
	}
};

const toUid = (value: string): number | null => {
	if (!/^\d+$/.test(value)) return null;
	const uid = Number.parseInt(value, 10);
	return Number.isSafeInteger(uid) ? uid : null;
};

const parseInotifyUsers = (
	users: string,
	knownUsers: string,
	defaultUid: number,
	executionUid: number,
) => {
	const result = new Map<
		number,
		{ uid: number; username: string | null; currentInstances: number }
	>();
	const add = (
		uid: number,
		username: string | null,
		currentInstances: number,
	) => {
		const existing = result.get(uid);
		if (existing) {
			existing.currentInstances += currentInstances;
			existing.username ??= username;
			return;
		}
		result.set(uid, { uid, username, currentInstances });
	};
	const readRows = (rows: string, currentInstances: number) => {
		for (const row of rows.split("\n")) {
			const [rawUid, rawUsername, rawInstances] = row.split("\t", 3);
			const uid = rawUid ? toUid(rawUid) : null;
			if (uid === null) continue;
			add(
				uid,
				rawUsername?.trim() || null,
				currentInstances === 0 ? 0 : (toUid(rawInstances ?? "") ?? 0),
			);
		}
	};

	readRows(knownUsers, 0);
	readRows(users, 1);
	add(defaultUid, null, 0);
	add(executionUid, null, 0);
	return [...result.values()].sort((a, b) => a.uid - b.uid);
};

// Single read-only script, one SSH/exec round-trip; inotify reports incomplete scans.
const buildHealthScript = (sinceHours: number) => `
containerCount=$(docker ps -a -q 2>/dev/null | wc -l | tr -d ' ')
serviceCount=$(docker service ls --format '{{.Name}}' 2>/dev/null | wc -l | tr -d ' ')

memTotal=$(free -b 2>/dev/null | awk '/^Mem:/{print $2}'); [ -z "$memTotal" ] && memTotal=0
memUsed=$(free -b 2>/dev/null | awk '/^Mem:/{print $3}'); [ -z "$memUsed" ] && memUsed=0
cpuCount=$(nproc 2>/dev/null); [ -z "$cpuCount" ] && cpuCount=0

inotifyProcRoot=/proc
inotifyError=""
if [ -d /host/proc ]; then
	inotifyProcRoot=/host/proc
elif [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then
	inotifyError="Host /proc is unavailable from the Dokploy container."
fi
inotifyExecutionUid=$(awk '/^Uid:/{print $2; exit}' /proc/self/status 2>/dev/null)
case "$inotifyExecutionUid" in *[!0-9]*|"") inotifyExecutionUid=0 ;; esac
inotifyEffectiveUid=$(id -u 2>/dev/null)
case "$inotifyEffectiveUid" in *[!0-9]*|"") inotifyEffectiveUid=65534 ;; esac
inotifyUseSudo=false
if [ "$inotifyEffectiveUid" -ne 0 ] && [ -z "$inotifyError" ]; then
	if sudo -n true >/dev/null 2>&1; then
		inotifyUseSudo=true
	else
		inotifyError="Inotify descriptor scan is unavailable: the SSH user cannot read all host /proc entries and passwordless sudo is unavailable."
	fi
fi
inotifyDefaultUid=0
if [ -z "$inotifyError" ]; then
	if [ "$inotifyUseSudo" = true ]; then
		inotifyDefaultUid=$(sudo -n awk 'FNR == 1 {daemon = ($2 == "dockerd")} daemon && /^Uid:/ {print $2; exit}' "$inotifyProcRoot"/[0-9]*/status 2>/dev/null)
	else
		inotifyDefaultUid=$(awk 'FNR == 1 {daemon = ($2 == "dockerd")} daemon && /^Uid:/ {print $2; exit}' "$inotifyProcRoot"/[0-9]*/status 2>/dev/null)
	fi
fi
case "$inotifyDefaultUid" in *[!0-9]*|"") inotifyDefaultUid=0 ;; esac
inotifyUsername() {
	[ "$inotifyProcRoot" = /proc ] || return 0
	getent passwd "$1" 2>/dev/null | cut -d: -f1 | head -n 1
}
inotifyKnownUsers=$(printf '%s\t%s\n%s\t%s\n' "$inotifyDefaultUid" "$(inotifyUsername "$inotifyDefaultUid")" "$inotifyExecutionUid" "$(inotifyUsername "$inotifyExecutionUid")")
inotifyUsers=""
if [ -z "$inotifyError" ]; then
	inotifyScanCommand='
procRoot=$1
inotifyFdDirs=$(LC_ALL=C find "$procRoot"/[0-9]*/fd -maxdepth 1 -type l \\( -lname "anon_inode:inotify" -o -lname "anon_inode:[[]inotify[]]" \\) -printf "%h\\n" 2>&1)
if printf "%s\\n" "$inotifyFdDirs" | grep -vE "^$procRoot/[0-9]+/fd$|^find: .*: No such file or directory$|^$" | grep -q .; then
	exit 2
fi
printf "%s\\n" "$inotifyFdDirs" | grep "^$procRoot/[0-9][0-9]*/fd$" | sort | uniq -c | while read -r count fdDir; do
	pid=\${fdDir#"$procRoot"/}
	pid=\${pid%/fd}
	status="$procRoot/$pid/status"
	uid=$(awk "/^Uid:/{print \\$2; exit}" "$status" 2>/dev/null)
	case "$uid" in *[!0-9]*|"") [ -e "$status" ] && exit 2; continue ;; esac
	username=""
	if [ "$procRoot" = /proc ]; then
		username=$(getent passwd "$uid" 2>/dev/null | cut -d: -f1 | head -n 1)
	fi
	printf "%s\\t%s\\t%s\\n" "$uid" "$username" "$count"
done
'
	if [ "$inotifyUseSudo" = true ]; then
		inotifyUsers=$(sudo -n sh -c "$inotifyScanCommand" sh "$inotifyProcRoot" 2>/dev/null)
	else
		inotifyUsers=$(sh -c "$inotifyScanCommand" sh "$inotifyProcRoot" 2>/dev/null)
	fi
	inotifyScanStatus=$?
	if [ "$inotifyScanStatus" -ne 0 ]; then
		inotifyUsers=""
		inotifyError="Inotify descriptor scan is unavailable: host /proc could not be read."
	fi
fi
inotifyMaxWatches=$(cat "$inotifyProcRoot/sys/fs/inotify/max_user_watches" 2>/dev/null); [ -z "$inotifyMaxWatches" ] && inotifyMaxWatches=0
inotifyMaxInstances=$(cat "$inotifyProcRoot/sys/fs/inotify/max_user_instances" 2>/dev/null); [ -z "$inotifyMaxInstances" ] && inotifyMaxInstances=0
inotifyMaxQueued=$(cat "$inotifyProcRoot/sys/fs/inotify/max_queued_events" 2>/dev/null); [ -z "$inotifyMaxQueued" ] && inotifyMaxQueued=0
if [ "$inotifyMaxInstances" -le 0 ]; then
	inotifyError="Inotify limits could not be read."
fi
inotifyPersistedCount=$(grep -rl inotify /etc/sysctl.conf /etc/sysctl.d/ 2>/dev/null | wc -l | tr -d ' ')
inotifyUsersB64=$(printf '%s' "$inotifyUsers" | base64 2>/dev/null | tr -d '\n')
inotifyKnownUsersB64=$(printf '%s' "$inotifyKnownUsers" | base64 2>/dev/null | tr -d '\n')
inotifyErrorB64=$(printf '%s' "$inotifyError" | base64 2>/dev/null | tr -d '\n')

diskTotal=$(df -B1 / 2>/dev/null | awk 'NR==2{print $2}'); [ -z "$diskTotal" ] && diskTotal=0
diskUsed=$(df -B1 / 2>/dev/null | awk 'NR==2{print $3}'); [ -z "$diskUsed" ] && diskUsed=0

networkCount=$(docker network ls -q 2>/dev/null | wc -l | tr -d ' ')
daemonConfigB64=$(cat /etc/docker/daemon.json 2>/dev/null | base64 2>/dev/null | tr -d '\\n')

daemonLogsToEpoch=$(date +%s 2>/dev/null); [ -z "$daemonLogsToEpoch" ] && daemonLogsToEpoch=0
daemonLogsFromEpoch=$((daemonLogsToEpoch - ${sinceHours} * 3600))

daemonErrorsB64=$(journalctl -u docker --no-pager --since "${sinceHours} hours ago" 2>/dev/null | grep -iE "inotify|too many open|cannot allocate|oom|conntrack|no space|pids.max|fork:|resource temporarily unavailable|could not find an available ip|no available ip|task allocation failure|address already in use" | tail -n 50 | base64 2>/dev/null | tr -d '\\n')

printf '{"containerCount":%s,"serviceCount":%s,"memTotalBytes":%s,"memUsedBytes":%s,"cpuCount":%s,"inotifyMaxWatches":%s,"inotifyMaxInstances":%s,"inotifyMaxQueuedEvents":%s,"inotifyPersistedCount":%s,"inotifyUsersBase64":"%s","inotifyKnownUsersBase64":"%s","inotifyDefaultUid":%s,"inotifyExecutionUid":%s,"inotifyErrorBase64":"%s","diskTotalBytes":%s,"diskUsedBytes":%s,"networkCount":%s,"daemonConfigBase64":"%s","daemonErrorsBase64":"%s","daemonLogsFromEpoch":%s,"daemonLogsToEpoch":%s}' "$containerCount" "$serviceCount" "$memTotal" "$memUsed" "$cpuCount" "$inotifyMaxWatches" "$inotifyMaxInstances" "$inotifyMaxQueued" "$inotifyPersistedCount" "$inotifyUsersB64" "$inotifyKnownUsersB64" "$inotifyDefaultUid" "$inotifyExecutionUid" "$inotifyErrorB64" "$diskTotal" "$diskUsed" "$networkCount" "$daemonConfigB64" "$daemonErrorsB64" "$daemonLogsFromEpoch" "$daemonLogsToEpoch"
`;

const emptyResult = (error: unknown): ServerHealthResult => ({
	checkedAt: new Date().toISOString(),
	containers: { containerCount: 0, serviceCount: 0 },
	resources: { memTotalBytes: 0, memUsedBytes: 0, cpuCount: 0 },
	inotify: {
		maxWatches: 0,
		maxInstances: 0,
		maxQueuedEvents: 0,
		persisted: false,
		users: [{ uid: 0, username: null, currentInstances: 0 }],
		defaultUid: 0,
	},
	disk: { totalBytes: 0, usedBytes: 0 },
	dockerNetworks: { count: 0, addressPools: null, usage: [] },
	daemonErrors: [],
	daemonLogsWindow: null,
	reservation: null,
	error:
		error instanceof Error ? error.message : "Could not read server health",
});

/** Usable host addresses in a subnet, excluding network + broadcast. Null if the subnet is missing/invalid. */
export const getSubnetCapacity = (
	subnet: string | undefined,
): number | null => {
	if (!subnet) return null;
	const prefix = Number.parseInt(subnet.split("/")[1] ?? "", 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
	const hostBits = 32 - prefix;
	if (hostBits <= 1) return 0;
	return 2 ** hostBits - 2;
};

type DockerNetworkSummary = {
	Name: string;
	Driver: string;
	IPAM?: { Config?: Array<{ Subnet?: string }> | null };
};

type InspectableNetwork = {
	inspect: (opts?: { verbose?: boolean }) => Promise<{
		Containers?: Record<string, unknown>;
	}>;
};

// Includes reserved networks like dokploy-network, which are excluded from the `network` table/UI.
const getNetworksIpUsage = async (
	serverId: string | undefined,
): Promise<NetworkIpUsage[]> => {
	const docker = await getRemoteDocker(serverId);
	const dockerNetworks =
		(await docker.listNetworks()) as DockerNetworkSummary[];
	const relevant = dockerNetworks.filter(
		(n) => n.Driver === "bridge" || n.Driver === "overlay",
	);

	const rows = await Promise.all(
		relevant.map(async (n): Promise<NetworkIpUsage> => {
			// IPv4 entry specifically: dual-stack networks list an IPv6 config too, and it may come first.
			const subnet = n.IPAM?.Config?.find(
				(c) => c.Subnet && !c.Subnet.includes(":"),
			)?.Subnet;
			const capacity = getSubnetCapacity(subnet);
			let containersInUse = 0;
			try {
				// Cast the object (not the detached method) so `net.inspect(...)` stays a bound method call.
				const net = docker.getNetwork(n.Name) as unknown as InspectableNetwork;
				// verbose: true for full swarm-wide container list on overlay networks
				const info = await net.inspect(
					n.Driver === "overlay" ? { verbose: true } : undefined,
				);
				containersInUse = Object.keys(info.Containers ?? {}).length;
			} catch {
				// Network may have disappeared between list and inspect; report 0
			}
			return {
				name: n.Name,
				driver: n.Driver,
				subnet: subnet ?? null,
				containersInUse,
				capacity,
				percentUsed:
					capacity && capacity > 0
						? Math.round((containersInUse / capacity) * 100)
						: null,
			};
		}),
	);

	return rows.sort((a, b) => (b.percentUsed ?? -1) - (a.percentUsed ?? -1));
};

// Sums Application memoryReservation/cpuReservation; Compose has no such columns.
export const getReservationSummary = async (
	orgId: string,
	serverId?: string,
) => {
	const appRows = await db
		.select({
			memoryReservation: applications.memoryReservation,
			cpuReservation: applications.cpuReservation,
		})
		.from(applications)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			and(
				eq(projects.organizationId, orgId),
				serverId
					? eq(applications.serverId, serverId)
					: isNull(applications.serverId),
			),
		);

	let memoryReservedBytes = 0;
	let cpuReservedNanoCpus = 0;
	for (const row of appRows) {
		if (row.memoryReservation) {
			memoryReservedBytes += toInt(row.memoryReservation);
		}
		if (row.cpuReservation) {
			cpuReservedNanoCpus += toInt(row.cpuReservation);
		}
	}

	const composeRows = await db
		.select({ composeId: compose.composeId })
		.from(compose)
		.innerJoin(
			environments,
			eq(compose.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			and(
				eq(projects.organizationId, orgId),
				serverId ? eq(compose.serverId, serverId) : isNull(compose.serverId),
			),
		);

	return {
		memoryReservedBytes,
		cpuReservedNanoCpus,
		appCount: appRows.length,
		unsupportedComposeCount: composeRows.length,
	};
};

export const getServerHealth = async (
	orgId: string,
	serverId?: string,
	sinceHours = 24,
): Promise<ServerHealthResult> => {
	if (IS_CLOUD && !serverId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Server is required",
		});
	}

	const hours = Math.max(
		1,
		Math.min(168, Math.floor(Number(sinceHours) || 24)),
	);
	const script = buildHealthScript(hours);

	let stdout = "";
	try {
		const result = serverId
			? await execAsyncRemote(serverId, script)
			: await execAsync(script);
		stdout = result.stdout;
	} catch (error) {
		return emptyResult(error);
	}

	let parsed: RawHealthOutput;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		return emptyResult(new Error("Could not parse server health output"));
	}

	const daemonErrors = b64Decode(parsed.daemonErrorsBase64)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	let addressPools: unknown = null;
	const daemonConfigText = b64Decode(parsed.daemonConfigBase64);
	if (daemonConfigText) {
		try {
			addressPools =
				JSON.parse(daemonConfigText)?.["default-address-pools"] ?? null;
		} catch {
			addressPools = null;
		}
	}

	// Not part of the shell script above: needs structured per-network data from the Docker API.
	const [reservation, networkUsageResult] = await Promise.all([
		getReservationSummary(orgId, serverId).catch(() => null),
		getNetworksIpUsage(serverId).then(
			(usage) => ({ usage, error: undefined }),
			(error: unknown) => ({
				usage: [] as NetworkIpUsage[],
				error:
					error instanceof Error
						? error.message
						: "Failed to read network usage",
			}),
		),
	]);

	return {
		checkedAt: new Date().toISOString(),
		containers: {
			containerCount: toInt(parsed.containerCount),
			serviceCount: toInt(parsed.serviceCount),
		},
		resources: {
			memTotalBytes: toInt(parsed.memTotalBytes),
			memUsedBytes: toInt(parsed.memUsedBytes),
			cpuCount: toInt(parsed.cpuCount),
		},
		inotify: {
			maxWatches: toInt(parsed.inotifyMaxWatches),
			maxInstances: toInt(parsed.inotifyMaxInstances),
			maxQueuedEvents: toInt(parsed.inotifyMaxQueuedEvents),
			persisted: toInt(parsed.inotifyPersistedCount) > 0,
			users: parseInotifyUsers(
				b64Decode(parsed.inotifyUsersBase64),
				b64Decode(parsed.inotifyKnownUsersBase64),
				toInt(parsed.inotifyDefaultUid),
				toInt(parsed.inotifyExecutionUid),
			),
			defaultUid: toInt(parsed.inotifyDefaultUid),
			error: b64Decode(parsed.inotifyErrorBase64) || undefined,
		},
		disk: {
			totalBytes: toInt(parsed.diskTotalBytes),
			usedBytes: toInt(parsed.diskUsedBytes),
		},
		dockerNetworks: {
			count: toInt(parsed.networkCount),
			addressPools,
			usage: networkUsageResult.usage,
			usageError: networkUsageResult.error,
		},
		daemonErrors,
		daemonLogsWindow:
			toInt(parsed.daemonLogsToEpoch) > 0
				? {
						fromEpoch: toInt(parsed.daemonLogsFromEpoch),
						toEpoch: toInt(parsed.daemonLogsToEpoch),
					}
				: null,
		reservation,
	};
};
