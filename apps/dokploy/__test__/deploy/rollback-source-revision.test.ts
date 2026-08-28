import { SWARM_READINESS_TRAEFIK_IMAGE } from "@dokploy/server/setup/traefik-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

const mocks = vi.hoisted(() => ({
	assertSwarmReadinessTraefikRuntime: vi.fn(),
	calculateResources: vi.fn(),
	deploymentSet: vi.fn(),
	findApplicationById: vi.fn(),
	findDeploymentById: vi.fn(),
	findStoredRollback: vi.fn(),
	generateBindMounts: vi.fn(),
	generateConfigContainer: vi.fn(),
	generateVolumeMounts: vi.fn(),
	getImageConfig: vi.fn(),
	getRemoteDocker: vi.fn(),
	persistedRollback: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	resolveServiceNetworks: vi.fn(),
	rollbackSet: vi.fn(),
	rollbacks: { rollbackId: "rollback.rollbackId" },
	deployments: { deploymentId: "deployment.deploymentId" },
	transaction: vi.fn(),
	withResolvedVaultRefs: vi.fn(),
}));

vi.mock("@dokploy/server/setup/traefik-setup", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/setup/traefik-setup")
	>("@dokploy/server/setup/traefik-setup");
	return {
		...actual,
		assertSwarmReadinessTraefikRuntime:
			mocks.assertSwarmReadinessTraefikRuntime,
	};
});

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));

vi.mock("@dokploy/server/db/schema", () => ({
	deployments: mocks.deployments,
	rollbacks: mocks.rollbacks,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			rollbacks: { findFirst: mocks.findStoredRollback },
		},
		transaction: mocks.transaction,
	},
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	findDeploymentById: mocks.findDeploymentById,
}));

vi.mock("@dokploy/server/services/docker-image", () => ({
	getImageConfig: mocks.getImageConfig,
}));

vi.mock("@dokploy/server/services/registry", () => ({
	findRegistryByIdWithCredentials: vi.fn(),
	safeDockerLoginCommand: vi.fn(),
}));

vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	getRegistryTag: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	calculateResources: mocks.calculateResources,
	generateBindMounts: mocks.generateBindMounts,
	generateConfigContainer: mocks.generateConfigContainer,
	generateVolumeMounts: mocks.generateVolumeMounts,
	prepareEnvironmentVariables: mocks.prepareEnvironmentVariables,
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: mocks.resolveServiceNetworks,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: mocks.withResolvedVaultRefs,
}));

const { createRollback, rollback } = await import(
	"@dokploy/server/services/rollbacks"
);

describe("createRollback source revision snapshot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("TRAEFIK_IMAGE", SWARM_READINESS_TRAEFIK_IMAGE);
		mocks.assertSwarmReadinessTraefikRuntime.mockResolvedValue(undefined);

		const where = vi.fn().mockResolvedValue(undefined);
		mocks.rollbackSet.mockImplementation((rollback) => {
			mocks.persistedRollback(rollback);
			return { where };
		});
		mocks.deploymentSet.mockImplementation(() => ({ where }));
		mocks.transaction.mockImplementation((callback) =>
			callback({
				insert: vi.fn(() => ({
					values: vi.fn(() => ({
						returning: vi.fn().mockResolvedValue([
							{
								deploymentId: "deployment-id",
								rollbackId: "rollback-id",
								version: 3,
							},
						]),
					})),
				})),
				query: {
					rollbacks: {
						findFirst: mocks.findStoredRollback,
					},
				},
				update: vi.fn((table) => ({
					set:
						table === mocks.rollbacks ? mocks.rollbackSet : mocks.deploymentSet,
				})),
			}),
		);
		mocks.findDeploymentById.mockResolvedValue({
			applicationId: "application-id",
		});
		mocks.findApplicationById.mockResolvedValue({
			buildRegistry: null,
			buildRegistryId: null,
			buildServerId: "build-server-id",
			deployments: [],
			github: null,
			labelsSwarm: {
				"otel.service.version": "${DOKPLOY_SOURCE_REVISION}",
			},
			registry: null,
			registryId: null,
			rollbackRegistry: null,
			rollbackRegistryId: null,
			serverId: null,
		});
		mocks.getImageConfig.mockResolvedValue({
			Config: {
				Labels: {
					"org.opencontainers.image.revision": sourceRevision,
				},
			},
		});
		mocks.findStoredRollback.mockResolvedValue({ rollbackId: "rollback-id" });
	});

	it("captures the prior OCI revision for a symbolic source-revision label", async () => {
		await createRollback({
			appName: "frontend-stg",
			deploymentId: "deployment-id",
		});

		expect(mocks.getImageConfig).toHaveBeenCalledWith(
			"frontend-stg:latest",
			"build-server-id",
		);
		expect(mocks.persistedRollback).toHaveBeenCalledWith(
			expect.objectContaining({
				fullContext: expect.objectContaining({ sourceRevision }),
			}),
		);
	});

	it("uses the current fail-closed domain labels during an image rollback", async () => {
		const fullContext = {
			appName: "crawl4ai",
			command: null,
			cpuLimit: null,
			cpuReservation: null,
			env: null,
			environment: { env: null, project: { env: null } },
			memoryLimit: null,
			memoryReservation: null,
			mounts: [],
			ports: [],
			rollbackRegistry: null,
		};
		const currentApplication = {
			...fullContext,
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
					https: false,
					port: 11235,
					customEntrypoint: null,
					path: "/",
					serviceName: null,
					domainType: "application",
					uniqueConfigKey: 7,
					createdAt: "",
					composeId: null,
					customCertResolver: null,
					applicationId: "application-id",
					previewDeploymentId: null,
					certificateType: "none",
					internalPath: "/",
					stripPath: false,
					middlewares: [],
					forwardAuthEnabled: false,
					enabled: true,
				},
			],
		};
		const serviceUpdate = vi.fn();
		mocks.findStoredRollback.mockResolvedValue({
			deploymentId: "deployment-id",
			fullContext,
			image: "crawl4ai:v3",
		});
		mocks.findApplicationById.mockResolvedValue(currentApplication);
		mocks.withResolvedVaultRefs.mockResolvedValue(fullContext);
		mocks.calculateResources.mockReturnValue({});
		mocks.generateBindMounts.mockReturnValue([]);
		mocks.generateConfigContainer.mockReturnValue({});
		mocks.generateVolumeMounts.mockReturnValue([]);
		mocks.prepareEnvironmentVariables.mockReturnValue([]);
		mocks.resolveServiceNetworks.mockResolvedValue([
			{ Target: "dokploy-network" },
		]);
		mocks.getRemoteDocker.mockResolvedValue({
			getService: () => ({
				inspect: vi.fn().mockResolvedValue({
					Version: { Index: 3 },
					Spec: { TaskTemplate: { ForceUpdate: 0 } },
				}),
				update: serviceUpdate,
			}),
		});

		await rollback("rollback-id");

		expect(serviceUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				Labels: expect.objectContaining({
					"traefik.http.routers.crawl4ai-7-web.service": "crawl4ai-7@swarm",
					"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.initialstatus":
						"down",
				}),
			}),
		);
	});
});
