import { ReadinessCheckSwarmSchema } from "@dokploy/server/db/schema/shared";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	assertSwarmReadinessTraefikRuntime: vi.fn(),
	createForwardAuthMiddleware: vi.fn(),
	listTasks: vi.fn(),
	loadOrCreateConfigRemote: vi.fn(),
	readTraefikRuntimeConfig: vi.fn(),
	removeForwardAuthMiddleware: vi.fn(),
	removePathMiddlewares: vi.fn(),
	removeTraefikConfig: vi.fn(),
	serviceInspect: vi.fn(),
	serviceUpdate: vi.fn(),
	writeTraefikConfigRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(async () => ({
		listTasks: mocks.listTasks,
		getService: vi.fn(() => ({
			inspect: mocks.serviceInspect,
			update: mocks.serviceUpdate,
		})),
	})),
}));

vi.mock("@dokploy/server/setup/traefik-setup", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/setup/traefik-setup")
	>("@dokploy/server/setup/traefik-setup");
	return {
		...actual,
		assertSwarmReadinessTraefikRuntime:
			mocks.assertSwarmReadinessTraefikRuntime,
		readTraefikRuntimeConfig: mocks.readTraefikRuntimeConfig,
	};
});

vi.mock("@dokploy/server/utils/traefik/application", () => ({
	createServiceConfig: vi.fn(),
	loadOrCreateConfig: vi.fn(),
	loadOrCreateConfigRemote: mocks.loadOrCreateConfigRemote,
	removeTraefikConfig: mocks.removeTraefikConfig,
	removeTraefikConfigRemote: vi.fn(),
	writeTraefikConfig: vi.fn(),
	writeTraefikConfigRemote: mocks.writeTraefikConfigRemote,
}));

vi.mock("@dokploy/server/utils/traefik/forward-auth", () => ({
	createForwardAuthMiddleware: mocks.createForwardAuthMiddleware,
	forwardAuthMiddlewareName: (appName: string, key: number) =>
		`forward-auth-${appName}-${key}`,
	removeForwardAuthMiddleware: mocks.removeForwardAuthMiddleware,
}));

vi.mock("@dokploy/server/utils/traefik/middleware", () => ({
	createPathMiddlewares: vi.fn(),
	removePathMiddlewares: mocks.removePathMiddlewares,
}));

const { createApplicationRoutingLabels, synchronizeApplicationRouting } =
	await import("@dokploy/server/utils/traefik/domain");
const { SWARM_READINESS_TRAEFIK_IMAGE } = await import(
	"@dokploy/server/setup/traefik-setup"
);

const application = {
	appName: "crawl4ai",
	serverId: "server-id",
	readinessCheckSwarm: {
		Path: "/health",
		Interval: 500_000_000,
		UnhealthyInterval: 250_000_000,
		Timeout: 400_000_000,
		Status: 200,
	},
	redirects: [],
	security: [],
	domains: [
		{
			domainId: "domain-id",
			host: "crawl.example.com",
			https: true,
			port: 11235,
			customEntrypoint: null,
			path: "/",
			serviceName: "compose-only-name",
			domainType: "application",
			uniqueConfigKey: 7,
			createdAt: "",
			composeId: null,
			customCertResolver: null,
			applicationId: "application-id",
			previewDeploymentId: null,
			certificateType: "letsencrypt",
			internalPath: "/",
			stripPath: false,
			middlewares: [],
			forwardAuthEnabled: false,
			enabled: true,
		},
	],
} as unknown as ApplicationNested;

describe("application Swarm readiness routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TRAEFIK_IMAGE", SWARM_READINESS_TRAEFIK_IMAGE);
		mocks.assertSwarmReadinessTraefikRuntime.mockResolvedValue(undefined);
		mocks.listTasks.mockResolvedValue([
			{
				DesiredState: "running",
				Status: { State: "running" },
				NetworksAttachments: [
					{
						Network: { Spec: { Name: "dokploy-network" } },
						Addresses: ["10.0.0.11/24"],
					},
				],
			},
		]);
		mocks.readTraefikRuntimeConfig.mockResolvedValue({
			middlewares: {
				"redirect-to-https@file": { status: "enabled" },
			},
			routers: {
				"crawl4ai-7-web@swarm": {
					middlewares: ["redirect-to-https@file"],
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
				"crawl4ai-7-websecure@swarm": {
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
				"crawl4ai-router-7@file": { status: "enabled" },
				"crawl4ai-router-websecure-7@file": { status: "enabled" },
			},
			services: {
				"crawl4ai-7@swarm": {
					status: "enabled",
					serverStatus: { "http://10.0.0.11:11235": "UP" },
				},
			},
		});
		mocks.serviceInspect.mockResolvedValue({
			Version: { Index: 9 },
			Spec: {
				Name: "crawl4ai",
				Labels: {
					"owner.example/preserved": "true",
					"traefik.http.routers.crawl4ai-99-web.rule": "stale",
				},
				TaskTemplate: {},
			},
		});
		mocks.loadOrCreateConfigRemote.mockResolvedValue({
			http: {
				routers: {
					"crawl4ai-router-7": {},
					"crawl4ai-router-websecure-7": {},
				},
				services: {},
			},
		});
	});

	it("renders deterministic direct-task routers and fail-closed health checks", () => {
		expect(createApplicationRoutingLabels(application)).toEqual({
			"traefik.enable": "true",
			"traefik.swarm.network": "dokploy-network",
			"traefik.swarm.lbswarm": "false",
			"traefik.http.routers.crawl4ai-7-web.rule": "Host(`crawl.example.com`)",
			"traefik.http.routers.crawl4ai-7-web.entrypoints": "web",
			"traefik.http.routers.crawl4ai-7-web.service": "crawl4ai-7@swarm",
			"traefik.http.routers.crawl4ai-7-web.middlewares":
				"redirect-to-https@file",
			"traefik.http.routers.crawl4ai-7-websecure.rule":
				"Host(`crawl.example.com`)",
			"traefik.http.routers.crawl4ai-7-websecure.entrypoints": "websecure",
			"traefik.http.routers.crawl4ai-7-websecure.service": "crawl4ai-7@swarm",
			"traefik.http.routers.crawl4ai-7-websecure.tls.certresolver":
				"letsencrypt",
			"traefik.http.services.crawl4ai-7.loadbalancer.server.port": "11235",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.path":
				"/health",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.interval":
				"500000000ns",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.unhealthyinterval":
				"250000000ns",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.timeout":
				"400000000ns",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.status": "200",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.initialstatus":
				"down",
		});
		expect(
			JSON.stringify(createApplicationRoutingLabels(application)),
		).not.toContain("compose-only-name");
	});

	it("rejects readiness checks that Traefik would silently retime", () => {
		expect(() =>
			ReadinessCheckSwarmSchema.parse({
				...application.readinessCheckSwarm,
				Interval: 400_000_000,
			}),
		).toThrow("Interval must be greater than Timeout");
	});

	it("updates root labels before deleting the legacy VIP file", async () => {
		await synchronizeApplicationRouting(application);

		expect(mocks.serviceUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				version: 9,
				Labels: expect.objectContaining({
					"owner.example/preserved": "true",
					"traefik.http.routers.crawl4ai-7-web.service": "crawl4ai-7@swarm",
				}),
			}),
		);
		const updatedLabels = mocks.serviceUpdate.mock.calls[0]?.[0]?.Labels;
		expect(updatedLabels).toHaveProperty(
			"traefik.http.routers.crawl4ai-7-web.priority",
		);
		expect(updatedLabels).not.toHaveProperty(
			"traefik.http.routers.crawl4ai-99-web.rule",
		);
		expect(mocks.removeTraefikConfig).toHaveBeenCalledWith(
			"crawl4ai",
			"server-id",
		);
		expect(mocks.serviceUpdate.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.removeTraefikConfig.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.serviceUpdate.mock.calls[1]?.[0]?.Labels).not.toHaveProperty(
			"traefik.http.routers.crawl4ai-7-web.priority",
		);
	});

	it("resynchronizes an already-native route without recreating a VIP file", async () => {
		mocks.loadOrCreateConfigRemote.mockResolvedValueOnce({
			http: { routers: {}, services: {} },
		});

		await synchronizeApplicationRouting(application);

		expect(mocks.serviceUpdate).toHaveBeenCalledTimes(1);
		expect(mocks.readTraefikRuntimeConfig).toHaveBeenCalled();
		expect(mocks.removeTraefikConfig).not.toHaveBeenCalled();
		expect(mocks.writeTraefikConfigRemote).not.toHaveBeenCalled();
	});

	it("withdraws native labels when the final application domain is disabled", async () => {
		await synchronizeApplicationRouting({
			...application,
			domains: application.domains.map((domain) => ({
				...domain,
				enabled: false,
			})),
		});

		expect(mocks.serviceUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				Labels: { "owner.example/preserved": "true" },
			}),
		);
		expect(mocks.removeTraefikConfig).toHaveBeenCalledWith(
			"crawl4ai",
			"server-id",
		);
	});

	it("keeps the legacy VIP route until every task backend is admitted", async () => {
		vi.useFakeTimers();
		const downRuntime = {
			routers: {
				"crawl4ai-7-web@swarm": {
					middlewares: ["redirect-to-https@file"],
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
				"crawl4ai-7-websecure@swarm": {
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
			},
			services: {
				"crawl4ai-7@swarm": {
					status: "enabled",
					serverStatus: { "http://10.0.0.11:11235": "DOWN" },
				},
			},
		};
		const upRuntime = {
			...downRuntime,
			middlewares: {
				"redirect-to-https@file": { status: "enabled" },
			},
			services: {
				"crawl4ai-7@swarm": {
					status: "enabled",
					serverStatus: { "http://10.0.0.11:11235": "UP" },
				},
			},
		};
		mocks.readTraefikRuntimeConfig
			.mockReset()
			.mockResolvedValueOnce(upRuntime)
			.mockResolvedValueOnce(downRuntime)
			.mockResolvedValue(upRuntime);

		const synchronization = synchronizeApplicationRouting(application);
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.removeTraefikConfig).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(500);
		await synchronization;
		expect(mocks.readTraefikRuntimeConfig).toHaveBeenCalledTimes(4);
		expect(mocks.removeTraefikConfig).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("converges a custom entrypoint onto the application service", async () => {
		const customEntrypointApplication = {
			...application,
			domains: [
				{
					...application.domains[0],
					customEntrypoint: "metrics",
					https: false,
				},
			],
		} as ApplicationNested;
		mocks.loadOrCreateConfigRemote.mockResolvedValueOnce({
			http: { routers: { "crawl4ai-router-7": {} }, services: {} },
		});
		mocks.readTraefikRuntimeConfig.mockResolvedValue({
			routers: {
				"crawl4ai-7-metrics@swarm": {
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
			},
			services: {
				"crawl4ai-7@swarm": {
					status: "enabled",
					serverStatus: { "http://10.0.0.11:11235": "UP" },
				},
			},
		});

		await synchronizeApplicationRouting(customEntrypointApplication);

		expect(mocks.removeTraefikConfig).toHaveBeenCalledTimes(1);
	});

	it("withdraws new Swarm labels when the legacy file cannot be deleted", async () => {
		mocks.removeTraefikConfig.mockRejectedValueOnce(
			new Error("legacy file deletion failed"),
		);

		await expect(synchronizeApplicationRouting(application)).rejects.toThrow(
			"legacy file deletion failed",
		);

		expect(mocks.serviceUpdate).toHaveBeenCalledTimes(2);
		expect(mocks.serviceUpdate.mock.calls[1]?.[0]?.Labels).toEqual({
			"owner.example/preserved": "true",
		});
		expect(
			mocks.writeTraefikConfigRemote.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.serviceUpdate.mock.invocationCallOrder[1] ?? 0);
	});

	it("rejects readiness when the rendered task omits the ingress network", async () => {
		await expect(
			synchronizeApplicationRouting({
				...application,
				networkSwarm: [{ Target: "isolated" }],
			}),
		).rejects.toThrow("requires the dokploy-network ingress network");
		expect(mocks.serviceUpdate).not.toHaveBeenCalled();
	});

	it("preserves the default file-provider route when readiness is disabled", () => {
		expect(
			createApplicationRoutingLabels({
				...application,
				readinessCheckSwarm: null,
			}),
		).toBeUndefined();
	});

	it("restores the VIP file route before withdrawing Swarm labels", async () => {
		await synchronizeApplicationRouting({
			...application,
			readinessCheckSwarm: null,
		});

		expect(mocks.writeTraefikConfigRemote).toHaveBeenCalledWith(
			expect.objectContaining({
				http: expect.objectContaining({
					routers: expect.objectContaining({
						"crawl4ai-router-7": expect.objectContaining({
							service: "crawl4ai-service-7",
						}),
					}),
				}),
			}),
			"crawl4ai",
			"server-id",
		);
		expect(
			mocks.writeTraefikConfigRemote.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.readTraefikRuntimeConfig.mock.invocationCallOrder[0] ?? 0);
		expect(
			mocks.readTraefikRuntimeConfig.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.serviceUpdate.mock.invocationCallOrder[0] ?? 0);
		expect(mocks.serviceUpdate.mock.calls[0]?.[0]?.Labels).toEqual({
			"owner.example/preserved": "true",
		});
	});

	it("keeps Swarm labels when the fallback VIP file cannot be written", async () => {
		mocks.writeTraefikConfigRemote.mockRejectedValueOnce(
			new Error("VIP file write failed"),
		);

		await expect(
			synchronizeApplicationRouting({
				...application,
				readinessCheckSwarm: null,
			}),
		).rejects.toThrow("VIP file write failed");
		expect(mocks.serviceUpdate).not.toHaveBeenCalled();
	});

	it("does not emit Swarm-provider labels in development", () => {
		vi.stubEnv("NODE_ENV", "development");
		expect(createApplicationRoutingLabels(application)).toBeUndefined();
	});

	it("does not emit readiness labels for an arbitrary immutable image", () => {
		vi.stubEnv("TRAEFIK_IMAGE", "registry.example.com/traefik@sha256:deadbeef");
		expect(createApplicationRoutingLabels(application)).toBeUndefined();
	});
});
