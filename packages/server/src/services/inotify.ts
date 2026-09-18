import { randomUUID } from "node:crypto";
import { getMonitoringImage } from "../setup/monitoring-setup";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

export interface InotifyUsage {
	maxWatches: number;
	maxInstances: number;
	maxQueuedEvents: number;
	persisted: boolean | null;
	users: Array<{
		uid: number;
		username: string | null;
		/** Distinct inotify instances, which is what the kernel limit charges. */
		currentInstances: number;
		/** Descriptors referring to them; higher wherever fork() shared one. */
		descriptorReferences: number;
	}>;
	defaultUid: number;
	error?: string;
}

const buildCommand = (remote: boolean) => {
	const name = `dokploy-inotify-${randomUUID()}`;
	// The reader shares the host PID namespace because kcmp(2) resolves its
	// process arguments in the caller's namespace; PIDs read from the bind-
	// mounted /proc mean nothing without it. Everything else stays dropped.
	return `set -eu
name=${name}
trap 'timeout -k 2 5 docker rm -f "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
security=$(timeout -k 2 10 docker info --format '{{json .SecurityOptions}}')
case "$security" in *name=rootless*|*name=userns*) exit 2 ;; esac
set -- --security-opt no-new-privileges
case "$security" in *name=apparmor*) set -- "$@" --security-opt apparmor=unconfined ;; esac
${remote ? "printf 'execution\\t%s\\n' \"$(id -ru)\"" : ""}
timeout -k 3 60 docker run --rm --name "$name" --pid host --network none --read-only --cap-drop ALL --cap-add SYS_PTRACE --cap-add DAC_READ_SEARCH --pids-limit 64 --memory 64m --cpus 0.5 --log-driver none --mount type=bind,src=/proc,dst=/host/proc,readonly "$@" ${getMonitoringImage()} ./main inotify-scan 2>/dev/null | head -c 65537
`;
};

const running = new Map<string, Promise<InotifyUsage>>();

export const getInotifyUsage = (serverId?: string): Promise<InotifyUsage> => {
	const key = serverId ?? "local";
	const existing = running.get(key);
	if (existing) return existing;
	const pending = (async (): Promise<InotifyUsage> => {
		const result: InotifyUsage = {
			maxWatches: 0,
			maxInstances: 0,
			maxQueuedEvents: 0,
			persisted: null,
			users: [],
			defaultUid: 0,
		};
		try {
			const command = buildCommand(Boolean(serverId));
			const { stdout } = serverId
				? await execAsyncRemote(serverId, command)
				: await execAsync(command);
			if (stdout.length > 65536 || !stdout.endsWith("end\n"))
				throw new Error("Incomplete scan");
			const counts = new Map<number, number>();
			const references = new Map<number, number>();
			const daemons = new Set<number>();
			let limits = false;
			for (const row of stdout.trimEnd().split("\n").slice(0, -1)) {
				const [kind, ...raw] = row.split("\t");
				if (
					raw.some(
						(value) =>
							!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)),
					)
				)
					throw new Error("Invalid scan");
				const values = raw.map(Number);
				const uid = values[0]!;
				switch (kind) {
					case "limits":
						if (
							limits ||
							values.length !== 3 ||
							values.some((value) => value <= 0)
						)
							throw new Error("Invalid limits");
						[result.maxWatches, result.maxInstances, result.maxQueuedEvents] =
							values as [number, number, number];
						limits = true;
						break;
					case "daemon":
					case "execution":
						if (values.length !== 1) throw new Error("Invalid UID");
						counts.set(uid, counts.get(uid) ?? 0);
						references.set(uid, references.get(uid) ?? 0);
						if (kind === "daemon") daemons.add(uid);
						break;
					case "user":
						if (values.length !== 3 || values[2]! > values[1]!)
							throw new Error("Invalid count");
						references.set(uid, (references.get(uid) ?? 0) + values[1]!);
						counts.set(uid, (counts.get(uid) ?? 0) + values[2]!);
						if (
							!Number.isSafeInteger(references.get(uid)) ||
							!Number.isSafeInteger(counts.get(uid))
						)
							throw new Error("Invalid count");
						break;
					default:
						throw new Error("Invalid scan");
				}
			}
			if (!limits || daemons.size !== 1)
				throw new Error("Docker daemon UID unavailable or ambiguous");
			result.defaultUid = [...daemons][0]!;
			result.users = [...counts]
				.sort(([a], [b]) => a - b)
				.map(([uid, currentInstances]) => ({
					uid,
					username: null,
					currentInstances,
					descriptorReferences: references.get(uid) ?? 0,
				}));
			return result;
		} catch {
			return {
				...result,
				users: [],
				error: "The host inotify scan failed or was incomplete.",
			};
		}
	})();
	running.set(key, pending);
	void pending.finally(() => running.delete(key));
	return pending;
};
