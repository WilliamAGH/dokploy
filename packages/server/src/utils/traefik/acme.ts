import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { paths, TRAEFIK_CONTAINER_NAME_FILTER } from "../../constants";
import { findServerById, getAllServers } from "../../services/server";
import { getDockerResourceType } from "../../services/settings";
import {
	execAsync,
	execAsyncRemote,
	sleep,
	writeFileRemote,
} from "../process/execAsync";
import type { MainTraefikConfig } from "./types";

export interface PrunedAcmeEntry {
	resolver: string;
	main: string;
	sans: string[];
	storagePath: string;
}

export interface TraefikAcmeStorageResult {
	storagePath: string;
	total: number;
	kept: number;
	pruned: PrunedAcmeEntry[];
}

export interface PruneTraefikAcmeResult {
	dryRun: boolean;
	restarted: boolean;
	scheduled: boolean;
	total: number;
	kept: number;
	pruned: PrunedAcmeEntry[];
	storages: TraefikAcmeStorageResult[];
}

export interface AcmePrunePlan extends TraefikAcmeStorageResult {
	nextJson: string;
}

interface RawRouterEntry {
	rule?: string;
	status?: string;
	entryPoints?: string[];
	tls?: {
		certResolver?: string;
		domains?: Array<{ main?: string; sans?: string[] }>;
	};
}

interface RawTraefikData {
	routers?: Record<string, RawRouterEntry>;
	tcpRouters?: Record<string, RawRouterEntry>;
}

interface AcmeCertificateRecord {
	domain?: { main?: string; Main?: string; sans?: string[]; SANs?: string[] };
	Domain?: { main?: string; Main?: string; sans?: string[]; SANs?: string[] };
	[key: string]: unknown;
}

type AcmeStoreFile = Record<
	string,
	{
		Account?: unknown;
		Certificates?: AcmeCertificateRecord[] | null;
		[key: string]: unknown;
	}
>;

const DEFAULT_ACME_RESOLVER = "letsencrypt";
const DEFAULT_ACME_STORAGE_PATH = "/etc/dokploy/traefik/dynamic/acme.json";
const PRUNE_DEBOUNCE_MS = 15_000;
const SWARM_STOP_TIMEOUT_MS = 30_000;
const SWARM_STOP_POLL_MS = 500;

const hostLocks = new Map<string, Promise<unknown>>();
const pendingDebounces = new Map<
	string,
	{ timer: ReturnType<typeof setTimeout>; hosts: Set<string> }
>();
const shellLiteral = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
export const normalizeHost = (host: string): string =>
	host.trim().toLowerCase().replace(/\.+$/, "");

const extractDomainHosts = (
	domains?: Array<{ main?: string; sans?: string[] }>,
) => (domains ?? []).flatMap((d) => [d.main ?? "", ...(d.sans ?? [])]);

const extractHostsFromRule = (rule: string): string[] =>
	Array.from(rule.matchAll(/(?:Host|HostSNI)\s*\(([^)]+)\)/gi)).flatMap((m) =>
		Array.from((m[1] ?? "").matchAll(/[`"']([^`"']+)[`"']/g))
			.map((t) => normalizeHost(t[1] ?? ""))
			.filter((h) => Boolean(h) && h !== "*"),
	);

export const discoverAcmeStorages = (
	traefikConfig: MainTraefikConfig | null | undefined,
): Array<{ storagePath: string; resolvers: string[] }> => {
	const byPath = new Map<string, string[]>();
	for (const [name, config] of Object.entries(
		traefikConfig?.certificatesResolvers ?? {},
	)) {
		const storage = config?.acme?.storage?.trim();
		if (storage) byPath.set(storage, [...(byPath.get(storage) ?? []), name]);
	}
	if (byPath.size === 0) {
		byPath.set(DEFAULT_ACME_STORAGE_PATH, [DEFAULT_ACME_RESOLVER]);
	}
	return Array.from(byPath, ([storagePath, resolvers]) => ({
		storagePath,
		resolvers,
	}));
};

export const collectActiveAcmeHosts = (
	rawData: RawTraefikData,
	traefikConfig?: MainTraefikConfig | null,
): Map<string, Set<string>> => {
	if (
		!rawData ||
		typeof rawData !== "object" ||
		(!rawData.routers && !rawData.tcpRouters)
	) {
		throw new Error("Traefik /api/rawdata returned no router map");
	}

	const defaultResolverByEntryPoint = new Map<string, string>();
	const byResolver = new Map<string, Set<string>>();
	const record = (resolver: string, host: string) => {
		const normalized = normalizeHost(host);
		if (!normalized || normalized === "*") return;
		const set = byResolver.get(resolver) ?? new Set<string>();
		set.add(normalized);
		byResolver.set(resolver, set);
	};

	for (const [epName, ep] of Object.entries(traefikConfig?.entryPoints ?? {})) {
		const resolver = ep?.http?.tls?.certResolver;
		if (!resolver) continue;
		defaultResolverByEntryPoint.set(epName, resolver);
		for (const h of extractDomainHosts(ep?.http?.tls?.domains))
			record(resolver, h);
	}

	for (const router of [
		...Object.values(rawData.routers ?? {}),
		...Object.values(rawData.tcpRouters ?? {}),
	]) {
		if (!router || router.status === "disabled") continue;
		const resolvers = new Set<string>(
			router.tls?.certResolver
				? [router.tls.certResolver]
				: router.tls
					? (router.entryPoints ?? [])
							.map((ep) => defaultResolverByEntryPoint.get(ep))
							.filter((r): r is string => Boolean(r))
					: [],
		);
		if (resolvers.size === 0) continue;

		const hosts = [
			...(router.rule ? extractHostsFromRule(router.rule) : []),
			...extractDomainHosts(router.tls?.domains),
		];
		for (const resolver of resolvers) {
			for (const host of hosts) record(resolver, host);
		}
	}

	return byResolver;
};

const hostMatchesCert = (activeHost: string, certHost: string) =>
	activeHost === certHost ||
	(certHost.startsWith("*.") &&
		activeHost.indexOf(".") > 0 &&
		activeHost.slice(activeHost.indexOf(".") + 1) === certHost.slice(2));

const matchesAny = (certDomains: string[], candidates: Set<string>) =>
	certDomains.some((c) => {
		for (const h of candidates) if (hostMatchesCert(h, c)) return true;
		return false;
	});

export const planAcmePrune = (
	acmeJsonRaw: string,
	activeByResolver: Map<string, Set<string>>,
	options: { storagePath: string; resolvers?: string[]; hosts?: string[] },
): AcmePrunePlan => {
	const parsed = JSON.parse(acmeJsonRaw) as AcmeStoreFile;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid acme.json structure at ${options.storagePath}`);
	}
	const hostFilter = options.hosts?.length
		? new Set(options.hosts.map(normalizeHost).filter(Boolean))
		: null;
	const resolverScope = options.resolvers?.length
		? new Set(options.resolvers)
		: null;

	const nextStore: AcmeStoreFile = {};
	const pruned: PrunedAcmeEntry[] = [];
	let total = 0;
	let kept = 0;

	for (const [resolverName, resolverData] of Object.entries(parsed)) {
		if (
			!resolverData ||
			typeof resolverData !== "object" ||
			!Array.isArray(resolverData.Certificates) ||
			(resolverScope && !resolverScope.has(resolverName))
		) {
			nextStore[resolverName] = resolverData;
			continue;
		}
		const activeHosts = activeByResolver.get(resolverName) ?? new Set<string>();
		const retained: AcmeCertificateRecord[] = [];
		for (const cert of resolverData.Certificates) {
			total += 1;
			const d = cert.domain ?? cert.Domain;
			const main = normalizeHost(d?.main ?? d?.Main ?? "");
			const rawSans = d?.sans ?? d?.SANs;
			const sans = Array.isArray(rawSans)
				? rawSans.map(normalizeHost).filter(Boolean)
				: [];
			const certDomains = [main, ...sans].filter(Boolean);
			if (
				certDomains.length > 0 &&
				!matchesAny(certDomains, activeHosts) &&
				(!hostFilter || matchesAny(certDomains, hostFilter))
			) {
				pruned.push({
					resolver: resolverName,
					main,
					sans,
					storagePath: options.storagePath,
				});
			} else {
				retained.push(cert);
				kept += 1;
			}
		}
		nextStore[resolverName] = { ...resolverData, Certificates: retained };
	}

	return {
		storagePath: options.storagePath,
		total,
		kept,
		pruned,
		nextJson: `${JSON.stringify(nextStore, null, 2)}\n`,
	};
};

const runHost = (command: string, serverId?: string) =>
	serverId ? execAsyncRemote(serverId, command) : execAsync(command);

const readHostFile = async (
	filePath: string,
	serverId?: string,
): Promise<string | null> => {
	if (!serverId) {
		return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
	}
	const { stdout } = await execAsyncRemote(
		serverId,
		`if [ -f ${shellLiteral(filePath)} ]; then cat ${shellLiteral(filePath)}; else printf '__DOKPLOY_MISSING_FILE__'; fi`,
	);
	return stdout === "__DOKPLOY_MISSING_FILE__" ? null : stdout;
};

const writeHostAcmeAtomic = async (
	filePath: string,
	content: string,
	serverId?: string,
): Promise<void> => {
	const { MAIN_TRAEFIK_PATH } = paths(Boolean(serverId));
	// Stage outside dynamic/ so Traefik's watcher never sees a partial file, with 0600 mode required by ACME.
	const stageDir = filePath.startsWith(MAIN_TRAEFIK_PATH)
		? MAIN_TRAEFIK_PATH
		: path.dirname(filePath);
	const tmpPath = path.posix.join(
		stageDir,
		`.acme-prune-${randomBytes(8).toString("hex")}.tmp`,
	);
	if (!serverId) {
		fs.writeFileSync(tmpPath, content, { mode: 0o600, encoding: "utf8" });
		fs.chmodSync(tmpPath, 0o600);
		fs.renameSync(tmpPath, filePath);
		return;
	}
	await writeFileRemote(serverId, tmpPath, content);
	await execAsyncRemote(
		serverId,
		`chmod 600 ${shellLiteral(tmpPath)} && mv -f ${shellLiteral(tmpPath)} ${shellLiteral(filePath)}`,
	);
};

const withHostLock = async <T>(
	lockKey: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const previous = hostLocks.get(lockKey) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = previous.catch(() => {}).then(() => current);
	hostLocks.set(lockKey, chain);
	await previous.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		if (hostLocks.get(lockKey) === chain) hostLocks.delete(lockKey);
	}
};

const withTraefikStopped = async <T>(
	serverId: string | undefined,
	fn: () => Promise<T>,
): Promise<T> => {
	const resourceType = await getDockerResourceType("dokploy-traefik", serverId);
	if (resourceType === "service") {
		const { stdout } = await runHost(
			`docker service inspect dokploy-traefik --format '{{.Spec.Mode.Replicated.Replicas}}'`,
			serverId,
		);
		const replicas = Math.max(1, Number.parseInt(stdout.trim(), 10) || 1);
		await runHost("docker service scale dokploy-traefik=0", serverId);
		try {
			const deadline = Date.now() + SWARM_STOP_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const ps = await runHost(
					`docker ps -q --filter "${TRAEFIK_CONTAINER_NAME_FILTER}"`,
					serverId,
				);
				if (!ps.stdout.trim()) return await fn();
				await sleep(SWARM_STOP_POLL_MS);
			}
			throw new Error(
				"Timed out waiting for dokploy-traefik container to stop",
			);
		} finally {
			await runHost(
				`docker service scale dokploy-traefik=${replicas}`,
				serverId,
			);
		}
	}
	if (resourceType === "standalone") {
		await runHost("docker stop dokploy-traefik", serverId);
		try {
			return await fn();
		} finally {
			await runHost("docker start dokploy-traefik", serverId);
		}
	}
	throw new Error("dokploy-traefik resource type not found");
};

export const pruneTraefikAcme = async (
	options: { serverId?: string; dryRun?: boolean; hosts?: string[] } = {},
): Promise<PruneTraefikAcmeResult> => {
	const { serverId, dryRun = false, hosts } = options;
	const lockKey = serverId
		? await findServerById(serverId).then(
				(s) => (s.ipAddress ? `host:${s.ipAddress}` : `server:${serverId}`),
				() => `server:${serverId}`,
			)
		: "local";

	return await withHostLock(lockKey, async () => {
		const { MAIN_TRAEFIK_PATH } = paths(Boolean(serverId));
		const rawYml = await readHostFile(
			path.posix.join(MAIN_TRAEFIK_PATH, "traefik.yml"),
			serverId,
		);
		const traefikConfig = rawYml
			? ((parse(rawYml) as MainTraefikConfig | null) ?? null)
			: null;
		const rawDataCmd = `cid=$(docker ps -q --filter "${TRAEFIK_CONTAINER_NAME_FILTER}" --filter "status=running" | head -n 1); [ -n "$cid" ] || { echo "dokploy-traefik container is not running" >&2; exit 1; }; docker exec "$cid" sh -c 'if command -v wget >/dev/null 2>&1; then wget -qO- http://127.0.0.1:8080/api/rawdata; else curl -fsS http://127.0.0.1:8080/api/rawdata; fi'`;
		const { stdout: rawDataOut } = await runHost(rawDataCmd, serverId);
		if (!rawDataOut.trim()) {
			throw new Error("Traefik /api/rawdata returned empty output");
		}
		const activeByResolver = collectActiveAcmeHosts(
			JSON.parse(rawDataOut.trim()) as RawTraefikData,
			traefikConfig,
		);
		const mappings = discoverAcmeStorages(traefikConfig);

		const evaluate = async (apply: boolean): Promise<AcmePrunePlan[]> => {
			const plans: AcmePrunePlan[] = [];
			for (const mapping of mappings) {
				const rawAcme = await readHostFile(mapping.storagePath, serverId);
				if (!rawAcme?.trim()) continue;
				const plan = planAcmePrune(rawAcme, activeByResolver, {
					storagePath: mapping.storagePath,
					resolvers: mapping.resolvers,
					hosts,
				});
				if (apply && plan.pruned.length > 0) {
					await writeHostAcmeAtomic(
						mapping.storagePath,
						plan.nextJson,
						serverId,
					);
				}
				plans.push(plan);
			}
			return plans;
		};
		const toResult = (
			plans: AcmePrunePlan[],
			restarted: boolean,
		): PruneTraefikAcmeResult => ({
			dryRun,
			restarted,
			scheduled: false,
			total: plans.reduce((sum, p) => sum + p.total, 0),
			kept: plans.reduce((sum, p) => sum + p.kept, 0),
			pruned: plans.flatMap((p) => p.pruned),
			storages: plans.map(({ storagePath, total, kept, pruned }) => ({
				storagePath,
				total,
				kept,
				pruned,
			})),
		});

		const initialPlans = await evaluate(false);
		if (dryRun || initialPlans.every((p) => p.pruned.length === 0)) {
			return toResult(initialPlans, false);
		}
		// Re-read acme.json after stopping Traefik so renewals flushed during shutdown are kept.
		return toResult(
			await withTraefikStopped(serverId, () => evaluate(true)),
			true,
		);
	});
};

export const scheduleTraefikAcmePrune = (
	serverId: string | null | undefined,
	hosts?: string[],
	debounceMs: number = PRUNE_DEBOUNCE_MS,
): void => {
	const normalizedServerId = serverId ?? undefined;
	const key = normalizedServerId ?? "local";
	const existing = pendingDebounces.get(key);
	const hostSet = existing?.hosts ?? new Set<string>();
	for (const host of hosts ?? []) {
		const normalized = normalizeHost(host);
		if (normalized) hostSet.add(normalized);
	}
	if (existing) clearTimeout(existing.timer);
	const timer = setTimeout(() => {
		pendingDebounces.delete(key);
		void pruneTraefikAcme({
			serverId: normalizedServerId,
			hosts: hostSet.size > 0 ? Array.from(hostSet) : undefined,
		}).catch((error) => {
			console.error(
				`[Traefik ACME] Background prune failed for ${key}:`,
				error,
			);
		});
	}, debounceMs);
	timer.unref?.();
	pendingDebounces.set(key, { timer, hosts: hostSet });
};

export const pruneTraefikAcmeAllServers = async (): Promise<void> => {
	const seenHosts = new Set<string>();
	const runTarget = async (label: string, serverId?: string) => {
		try {
			await pruneTraefikAcme({ serverId });
		} catch (error) {
			console.error(
				`[Traefik ACME] Scheduled prune failed for ${label}:`,
				error,
			);
		}
	};
	await runTarget("control plane");
	for (const server of await getAllServers()) {
		const hostKey = server.ipAddress || server.serverId;
		if (seenHosts.has(hostKey)) continue;
		seenHosts.add(hostKey);
		await runTarget(
			`server ${server.name} (${server.serverId})`,
			server.serverId,
		);
	}
};
