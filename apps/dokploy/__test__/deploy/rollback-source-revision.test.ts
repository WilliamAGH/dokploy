import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

const mocks = vi.hoisted(() => ({
	deploymentSet: vi.fn(),
	findApplicationById: vi.fn(),
	findDeploymentById: vi.fn(),
	findStoredRollback: vi.fn(),
	getImageConfig: vi.fn(),
	getRemoteDocker: vi.fn(),
	generateConfigContainer: vi.fn(),
	generateFileMounts: vi.fn(),
	generateBindMounts: vi.fn(),
	generateVolumeMounts: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	persistedRollback: vi.fn(),
	resolveServiceNetworks: vi.fn(),
	rollbackSet: vi.fn(),
	serviceInspect: vi.fn(),
	serviceUpdate: vi.fn(),
	rollbacks: { rollbackId: "rollback.rollbackId" },
	deployments: { deploymentId: "deployment.deploymentId" },
	transaction: vi.fn(),
}));

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
			rollbacks: {
				findFirst: mocks.findStoredRollback,
			},
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

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: mocks.resolveServiceNetworks,
}));

vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	getRegistryTag: vi.fn(),
}));

vi.mock("@dokploy/server/utils/docker/utils", () => ({
	calculateResources: vi.fn(),
	generateBindMounts: mocks.generateBindMounts,
	generateConfigContainer: mocks.generateConfigContainer,
	generateFileMounts: mocks.generateFileMounts,
	generateVolumeMounts: mocks.generateVolumeMounts,
	prepareEnvironmentVariables: mocks.prepareEnvironmentVariables,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: vi.fn((context) => context),
}));

const { createRollback, rollback } = await import(
	"@dokploy/server/services/rollbacks"
);

describe("rollback context", () => {
	const candidateImage = `registry.example.com/app@sha256:${"a".repeat(64)}`;
	const baselineImage = `registry.example.com/app@sha256:${"b".repeat(64)}`;

	beforeEach(() => {
		vi.clearAllMocks();

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

	it("uses the live immutable Docker baseline image and labels", async () => {
		mocks.findApplicationById.mockResolvedValue({
			buildRegistry: null,
			buildRegistryId: null,
			buildServerId: "build-server-id",
			deployments: [],
			dockerImage: candidateImage,
			github: null,
			labelsSwarm: {
				"otel.service.version": "${DOKPLOY_SOURCE_REVISION}",
			},
			registry: null,
			registryId: null,
			rollbackRegistry: null,
			rollbackRegistryId: null,
			serverId: null,
			sourceType: "docker",
		});

		await createRollback({
			appName: "crawl4ai-production",
			deploymentId: "deployment-id",
			rollbackSource: {
				image: baselineImage,
				labels: { "otel.service.version": sourceRevision },
			},
		});

		expect(mocks.getImageConfig).not.toHaveBeenCalled();
		expect(mocks.persistedRollback).toHaveBeenCalledWith(
			expect.objectContaining({
				fullContext: expect.objectContaining({
					dockerImage: baselineImage,
					labelsSwarm: { "otel.service.version": sourceRevision },
				}),
			}),
		);
	});

	it("restores the complete immutable Docker service spec", async () => {
		mocks.getRemoteDocker.mockResolvedValue({
			getService: vi.fn(() => ({
				inspect: mocks.serviceInspect,
				update: mocks.serviceUpdate,
			})),
		});
		mocks.serviceInspect.mockResolvedValue({
			Spec: { TaskTemplate: { ForceUpdate: 7 } },
			Version: { Index: "23" },
		});
		mocks.resolveServiceNetworks.mockResolvedValue([]);
		mocks.generateBindMounts.mockReturnValue([]);
		mocks.generateVolumeMounts.mockReturnValue([]);
		mocks.prepareEnvironmentVariables.mockReturnValue(["KEY=value"]);
		mocks.generateFileMounts.mockReturnValue([
			{ Source: "/files/config", Target: "/app/config", Type: "bind" },
		]);
		mocks.generateConfigContainer.mockReturnValue({
			EndpointSpec: { Mode: "vip", Ports: [] },
			HealthCheck: { Test: ["CMD", "true"] },
			Labels: { "otel.service.version": sourceRevision },
			Mode: { Replicated: { Replicas: 3 } },
			Placement: { MaxReplicas: 1 },
			RestartPolicy: { Condition: "any" },
			RollbackConfig: { Order: "start-first" },
			StopGracePeriod: 390_000_000_000,
			Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 2048 }],
			UpdateConfig: { Order: "start-first" },
		});
		mocks.findStoredRollback.mockResolvedValue({
			deploymentId: "deployment-id",
			fullContext: {
				appName: "crawl4ai",
				args: ["--serve"],
				command: "python server.py",
				dockerImage: baselineImage,
				env: "KEY=value",
				environment: { env: "", project: { env: "" } },
				mounts: [],
				ports: [],
				rollbackRegistry: { registryUrl: "registry.example.com" },
				serverId: null,
				sourceType: "docker",
			},
			image: "crawl4ai:v3",
			rollbackId: "rollback-id",
		});
		mocks.findApplicationById.mockResolvedValue({
			appName: "crawl4ai",
			serverId: null,
		});

		await rollback("rollback-id");

		expect(mocks.serviceUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				EndpointSpec: { Mode: "vip", Ports: [] },
				TaskTemplate: expect.objectContaining({
					ContainerSpec: expect.objectContaining({
						Args: ["--serve"],
						Command: ["python", "server.py"],
						Image: baselineImage,
						Mounts: [
							{
								Source: "/files/config",
								Target: "/app/config",
								Type: "bind",
							},
						],
						StopGracePeriod: 390_000_000_000,
					}),
					ForceUpdate: 8,
				}),
			}),
		);
	});
});
