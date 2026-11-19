import {
	collectActiveAcmeHosts,
	discoverAcmeStorages,
	normalizeHost,
	planAcmePrune,
	pruneTraefikAcme,
} from "@dokploy/server/utils/traefik/acme";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	sleep: vi.fn(),
	findServerById: vi.fn(),
	getAllServers: vi.fn(),
	getDockerResourceType: vi.fn(),
	reconnectServicesToTraefik: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	writeFileRemote: mocks.writeFileRemote,
	sleep: mocks.sleep,
}));

vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
	getAllServers: mocks.getAllServers,
}));

vi.mock("@dokploy/server/services/settings", () => ({
	getDockerResourceType: mocks.getDockerResourceType,
	reconnectServicesToTraefik: mocks.reconnectServicesToTraefik,
}));

describe("discoverAcmeStorages", () => {
	it("groups resolvers sharing a storage file and falls back to default letsencrypt", () => {
		expect(discoverAcmeStorages(null)).toEqual([
			{
				storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
				resolvers: ["letsencrypt"],
			},
		]);

		expect(
			discoverAcmeStorages({
				certificatesResolvers: {
					letsencrypt: {
						acme: { storage: "/etc/dokploy/traefik/dynamic/acme.json" },
					},
					dns01: {
						acme: { storage: "/etc/dokploy/traefik/dynamic/acme.json" },
					},
					custom: {
						acme: { storage: "/etc/dokploy/traefik/dynamic/acme-custom.json" },
					},
				},
			}),
		).toEqual([
			{
				storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
				resolvers: ["letsencrypt", "dns01"],
			},
			{
				storagePath: "/etc/dokploy/traefik/dynamic/acme-custom.json",
				resolvers: ["custom"],
			},
		]);
	});
});

describe("normalizeHost", () => {
	it("normalizes case, trailing dots, and IDN punycode including wildcards", () => {
		expect(normalizeHost(" App.Example.COM. ")).toBe("app.example.com");
		expect(normalizeHost("bücher.example.com")).toBe(
			"xn--bcher-kva.example.com",
		);
		expect(normalizeHost("*.bücher.example.com")).toBe(
			"*.xn--bcher-kva.example.com",
		);
	});
});

describe("collectActiveAcmeHosts", () => {
	it("extracts Host, HostSNI, tls.domains, router.using, entrypoint defaults, and retains disabled routers", () => {
		const active = collectActiveAcmeHosts(
			{
				routers: {
					"app-web@file": {
						status: "enabled",
						rule: "Host(`App.Example.com`, `www.example.com`) && PathPrefix(`/api`)",
						entryPoints: ["websecure"],
						tls: { certResolver: "letsencrypt" },
					},
					"ep-default@file": {
						status: "enabled",
						rule: "Host(`fallback.example.com`)",
						entryPoints: ["websecure"],
						tls: {},
					},
					"using-default@docker": {
						status: "enabled",
						rule: "Host(`using-ep.example.com`)",
						using: ["web", "websecure"],
						tls: {},
					},
					"disabled-app@file": {
						status: "disabled",
						rule: "Host(`transient-down.example.com`)",
						entryPoints: ["websecure"],
						tls: { certResolver: "letsencrypt" },
					},
					"no-tls@file": {
						status: "enabled",
						rule: "Host(`plain.example.com`)",
						entryPoints: ["web"],
					},
				},
				tcpRouters: {
					"pg-tls@file": {
						status: "enabled",
						rule: "HostSNI(`db.example.com`)",
						tls: {
							certResolver: "dns01",
							domains: [
								{ main: "*.wild.example.com", sans: ["wild.example.com"] },
							],
						},
					},
				},
			},
			{
				entryPoints: {
					websecure: {
						address: ":443",
						http: {
							tls: {
								certResolver: "letsencrypt",
								domains: [{ main: "static-ep.example.com", sans: [] }],
							},
						},
					},
				},
			},
		);

		expect(Array.from(active.get("letsencrypt") ?? []).sort()).toEqual([
			"app.example.com",
			"fallback.example.com",
			"static-ep.example.com",
			"transient-down.example.com",
			"using-ep.example.com",
			"www.example.com",
		]);
		expect(Array.from(active.get("dns01") ?? []).sort()).toEqual([
			"*.wild.example.com",
			"db.example.com",
			"wild.example.com",
		]);
	});

	it("fails closed when /api/rawdata lacks a router map", () => {
		expect(() => collectActiveAcmeHosts({})).toThrow(
			"Traefik /api/rawdata returned no router map",
		);
	});
});

describe("planAcmePrune", () => {
	const sampleStore = JSON.stringify({
		letsencrypt: {
			Account: { Email: "ops@example.com", PrivateKey: "KEEP-ACCOUNT" },
			Certificates: [
				{
					domain: { main: "active.example.com" },
					certificate: "CERT1",
					key: "KEY1",
				},
				{
					domain: { main: "*.wild.example.com" },
					certificate: "CERT2",
					key: "KEY2",
				},
				{
					domain: { main: "stale-one.example.com" },
					certificate: "CERT3",
					key: "KEY3",
				},
				{
					domain: {
						main: "stale-two.example.com",
						sans: ["active-san.example.com"],
					},
					certificate: "CERT4",
					key: "KEY4",
				},
				{
					domain: { main: "stale-three.example.com" },
					certificate: "CERT5",
					key: "KEY5",
				},
			],
		},
		otherResolver: {
			Account: { Email: "other@example.com" },
			Certificates: [
				{ domain: { main: "untouched.example.com" }, certificate: "CERT6" },
			],
		},
	});

	it("keeps active exact, SAN, and wildcard certs, preserves Account and unscoped resolvers, and prunes only orphans", () => {
		const active = new Map<string, Set<string>>([
			[
				"letsencrypt",
				new Set([
					"active.example.com",
					"sub.wild.example.com",
					"active-san.example.com",
				]),
			],
		]);

		const plan = planAcmePrune(sampleStore, active, {
			storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
			resolvers: ["letsencrypt"],
		});

		expect(plan.total).toBe(5);
		expect(plan.kept).toBe(3);
		expect(plan.pruned).toEqual([
			{
				resolver: "letsencrypt",
				main: "stale-one.example.com",
				sans: [],
				storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
			},
			{
				resolver: "letsencrypt",
				main: "stale-three.example.com",
				sans: [],
				storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
			},
		]);

		const next = JSON.parse(plan.nextJson);
		expect(next.letsencrypt.Account).toEqual({
			Email: "ops@example.com",
			PrivateKey: "KEEP-ACCOUNT",
		});
		expect(next.letsencrypt.Certificates).toHaveLength(3);
		expect(next.otherResolver.Certificates).toHaveLength(1);
	});

	it("honors targeted host filter without removing active hosts or unrelated orphans", () => {
		const active = new Map<string, Set<string>>([
			["letsencrypt", new Set(["active.example.com"])],
		]);

		const plan = planAcmePrune(sampleStore, active, {
			storagePath: "/etc/dokploy/traefik/dynamic/acme.json",
			resolvers: ["letsencrypt"],
			hosts: ["active.example.com", "stale-one.example.com"],
		});

		expect(plan.pruned.map((p) => p.main)).toEqual(["stale-one.example.com"]);
		expect(plan.kept).toBe(4);
	});
});

describe("pruneTraefikAcme remote execution", () => {
	const traefikYml = `
certificatesResolvers:
  letsencrypt:
    acme:
      storage: /etc/dokploy/traefik/dynamic/acme.json
`;
	const rawData = JSON.stringify({
		routers: {
			"live@file": {
				status: "enabled",
				rule: "Host(`live.example.com`)",
				tls: { certResolver: "letsencrypt" },
			},
		},
	});
	const acmeWithStale = JSON.stringify({
		letsencrypt: {
			Account: { Email: "ops@example.com" },
			Certificates: [
				{ domain: { main: "live.example.com" }, certificate: "LIVE" },
				{ domain: { main: "dead.example.com" }, certificate: "DEAD" },
			],
		},
	});
	const acmeClean = JSON.stringify({
		letsencrypt: {
			Account: { Email: "ops@example.com" },
			Certificates: [
				{ domain: { main: "live.example.com" }, certificate: "LIVE" },
			],
		},
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findServerById.mockResolvedValue({
			serverId: "srv-1",
			ipAddress: "100.64.0.5",
		});
		mocks.getDockerResourceType.mockResolvedValue("standalone");
		mocks.writeFileRemote.mockResolvedValue(undefined);
		mocks.reconnectServicesToTraefik.mockResolvedValue(undefined);
	});

	it("does not restart Traefik when zero orphans exist", async () => {
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeClean, stderr: "" });

		const res = await pruneTraefikAcme({ serverId: "srv-1" });

		expect(res.restarted).toBe(false);
		expect(res.pruned).toEqual([]);
		expect(res.kept).toBe(1);
		expect(mocks.writeFileRemote).not.toHaveBeenCalled();
	});

	it("stops standalone Traefik, pre-creates 0600 temp file outside dynamic/, writes, moves, and restarts", async () => {
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // docker stop
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" }) // fresh re-read
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // install -m 600
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // chmod + mv
			.mockResolvedValueOnce({ stdout: "", stderr: "" }); // docker start

		const res = await pruneTraefikAcme({ serverId: "srv-1" });

		expect(res.restarted).toBe(true);
		expect(res.pruned.map((p) => p.main)).toEqual(["dead.example.com"]);
		expect(mocks.writeFileRemote).toHaveBeenCalledOnce();
		const [srvId, tmpPath, writtenJson] = mocks.writeFileRemote.mock.calls[0]!;
		expect(srvId).toBe("srv-1");
		expect(tmpPath).toMatch(
			/^\/etc\/dokploy\/traefik\/\.acme-prune-[a-f0-9]+\.tmp$/,
		);
		expect(JSON.parse(writtenJson).letsencrypt.Certificates).toHaveLength(1);

		const commands = mocks.execAsyncRemote.mock.calls.map((c) => String(c[1]));
		expect(commands).toContain("docker stop dokploy-traefik");
		expect(commands).toContain("docker start dokploy-traefik");
		expect(
			commands.some((c) => c.startsWith("install -m 600 /dev/null ")),
		).toBe(true);
		expect(
			commands.some((c) => c.includes("chmod 600") && c.includes("mv -f")),
		).toBe(true);
	});

	it("cleans up temp file and restarts Traefik in finally even if write or stop fails", async () => {
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" })
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // docker stop
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" }) // fresh re-read
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // install -m 600
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // rm -f tmp
			.mockResolvedValueOnce({ stdout: "", stderr: "" }); // docker start in finally
		mocks.writeFileRemote.mockRejectedValueOnce(new Error("disk full"));

		await expect(pruneTraefikAcme({ serverId: "srv-1" })).rejects.toThrow(
			"disk full",
		);

		const commands = mocks.execAsyncRemote.mock.calls.map((c) => String(c[1]));
		expect(commands.some((c) => c.startsWith("rm -f "))).toBe(true);
		expect(commands.at(-1)).toBe("docker start dokploy-traefik");

		// Even if docker stop rejects mid-command, finally still runs docker start.
		vi.clearAllMocks();
		mocks.findServerById.mockResolvedValue({
			serverId: "srv-1",
			ipAddress: "100.64.0.5",
		});
		mocks.getDockerResourceType.mockResolvedValue("standalone");
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" })
			.mockRejectedValueOnce(new Error("ssh channel dropped")) // docker stop fails
			.mockResolvedValueOnce({ stdout: "", stderr: "" }); // docker start in finally

		await expect(pruneTraefikAcme({ serverId: "srv-1" })).rejects.toThrow(
			"ssh channel dropped",
		);
		expect(
			mocks.execAsyncRemote.mock.calls.map((c) => String(c[1])).at(-1),
		).toBe("docker start dokploy-traefik");
	});

	it("scales Swarm Traefik to 0, prunes, restores replicas, waits running, and reconnects isolated networks", async () => {
		mocks.getDockerResourceType.mockResolvedValue("service");
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" })
			.mockResolvedValueOnce({ stdout: "1\n", stderr: "" }) // inspect replicas
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // scale 0
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // wait stopped
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" }) // fresh re-read
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // install -m 600
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // chmod + mv
			.mockResolvedValueOnce({ stdout: "", stderr: "" }) // scale 1
			.mockResolvedValueOnce({ stdout: "abc123\n", stderr: "" }); // wait running

		const res = await pruneTraefikAcme({ serverId: "srv-1" });

		expect(res.restarted).toBe(true);
		const commands = mocks.execAsyncRemote.mock.calls.map((c) => String(c[1]));
		expect(commands).toContain("docker service scale dokploy-traefik=0");
		expect(commands).toContain("docker service scale dokploy-traefik=1");
		expect(mocks.reconnectServicesToTraefik).toHaveBeenCalledWith("srv-1");
	});

	it("rejects Swarm global-mode Traefik cleanly before mutating service state", async () => {
		mocks.getDockerResourceType.mockResolvedValue("service");
		mocks.execAsyncRemote
			.mockResolvedValueOnce({ stdout: traefikYml, stderr: "" })
			.mockResolvedValueOnce({ stdout: rawData, stderr: "" })
			.mockResolvedValueOnce({ stdout: acmeWithStale, stderr: "" })
			.mockResolvedValueOnce({ stdout: "global\n", stderr: "" });

		await expect(pruneTraefikAcme({ serverId: "srv-1" })).rejects.toThrow(
			"global mode is not supported",
		);
	});
});
