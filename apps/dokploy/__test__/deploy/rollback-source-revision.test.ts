import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

const mocks = vi.hoisted(() => ({
	deploymentSet: vi.fn(),
	deploymentRetryReturning: vi.fn(),
	deploymentSubmissionInsert: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findApplicationById: vi.fn(),
	findDeploymentById: vi.fn(),
	findStoredRollback: vi.fn(),
	getAuthConfig: vi.fn(),
	getImageConfig: vi.fn(),
	getRemoteDocker: vi.fn(),
	getRegistryTag: vi.fn(),
	generateConfigContainer: vi.fn(),
	generateFileMounts: vi.fn(),
	generateBindMounts: vi.fn(),
	generateVolumeMounts: vi.fn(),
	prepareEnvironmentVariables: vi.fn(),
	persistedRollback: vi.fn(),
	resolveServiceNetworks: vi.fn(),
	rollbackSet: vi.fn(),
	safeDockerLoginCommand: vi.fn(),
	updateSwarmService: vi.fn(),
	rollbacks: { rollbackId: "rollback.rollbackId" },
	deployments: { deploymentId: "deployment.deploymentId" },
	transaction: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...condition: unknown[]) => condition),
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
	inArray: vi.fn((field: string, value: unknown) => ({ field, value })),
}));

vi.mock("@dokploy/server/db/schema", () => ({
	deployments: mocks.deployments,
	rollbacks: mocks.rollbacks,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		insert: mocks.deploymentSubmissionInsert,
		update: vi.fn(() => ({
			set: vi.fn(() => ({
				where: vi.fn(() => ({ returning: mocks.deploymentRetryReturning })),
			})),
		})),
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
	safeDockerLoginCommand: mocks.safeDockerLoginCommand,
}));

vi.mock("@dokploy/server/utils/builders/auth", () => ({
	getAuthConfig: mocks.getAuthConfig,
}));

vi.mock("@dokploy/server/services/network", () => ({
	resolveServiceNetworks: mocks.resolveServiceNetworks,
}));

vi.mock("@dokploy/server/utils/cluster/upload", () => ({
	getRegistryTag: mocks.getRegistryTag,
	isImmutableImage: (image: string) => /@sha256:[a-f0-9]{64}$/.test(image),
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
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/utils/docker/swarm-update", () => ({
	DEPLOYMENT_ID_LABEL: "dokploy.deployment.id",
	updateSwarmService: mocks.updateSwarmService,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/utils/vault", () => ({
	withResolvedVaultRefs: vi.fn((context) => context),
}));

const { createRollback, createRollbackDeploymentSubmission, rollback } =
	await import("@dokploy/server/services/rollbacks");
const { decryptValue, encryptValue } = await import(
	"@dokploy/server/lib/encryption"
);
const { ExecError } = await import("@dokploy/server/utils/process/ExecError");

const persistedContext = () => {
	const stored = mocks.persistedRollback.mock.calls.at(-1)?.[0].fullContext as {
		encrypted: string;
	};
	expect(stored).toEqual({ encrypted: expect.any(String) });
	return JSON.parse(decryptValue(stored.encrypted));
};

describe("rollback context", () => {
	const candidateImage = `registry.example.com/app@sha256:${"a".repeat(64)}`;
	const baselineImage = `registry.example.com/app@sha256:${"b".repeat(64)}`;

	beforeEach(() => {
		vi.clearAllMocks();

		const where = vi.fn().mockResolvedValue(undefined);
		mocks.rollbackSet.mockImplementation((rollback) => {
			mocks.persistedRollback(rollback);
			return {
				where: vi.fn(() => ({
					returning: vi.fn().mockResolvedValue([
						{
							deploymentId: "deployment-id",
							rollbackId: "rollback-id",
							version: 3,
							...rollback,
						},
					]),
				})),
			};
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
		mocks.deploymentSubmissionInsert.mockReturnValue({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => ({
					returning: vi.fn().mockResolvedValue([
						{
							deploymentId: "rollback-rollback-id",
							logPath: "",
							status: "running",
						},
					]),
				})),
			})),
		});
		mocks.deploymentRetryReturning.mockResolvedValue([]);
		mocks.getAuthConfig.mockResolvedValue(undefined);
		mocks.getRemoteDocker.mockResolvedValue({
			getService: vi.fn(() => ({
				inspect: vi.fn().mockResolvedValue({
					Spec: {
						TaskTemplate: {
							ContainerSpec: {
								Labels: {
									"dokploy.deployment.id": "rollback-rollback-id",
								},
							},
						},
					},
				}),
			})),
		});
		mocks.getRegistryTag.mockImplementation((_registry, image) => image);
		mocks.safeDockerLoginCommand.mockReturnValue("docker login");
		mocks.updateSwarmService.mockResolvedValue(undefined);
	});

	it("persists one deterministic deployment row and reuses it on replay", async () => {
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				applicationId: "application-id",
				application: { appName: "app", serverId: null },
			},
			rollbackId: "rollback-id",
		});

		const submission = await createRollbackDeploymentSubmission(
			"rollback-id",
			"application-id",
		);

		expect(submission).toEqual({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "",
				status: "running",
			},
			shouldDispatch: true,
		});
		expect(mocks.deploymentSubmissionInsert).toHaveBeenCalledOnce();

		mocks.deploymentSubmissionInsert.mockReturnValue({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => ({
					returning: vi.fn().mockResolvedValue([]),
				})),
			})),
		});
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "rollback-rollback-id",
			logPath: "",
			status: "done",
		});

		await expect(
			createRollbackDeploymentSubmission("rollback-id", "application-id"),
		).resolves.toEqual({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "",
				status: "done",
			},
			shouldDispatch: false,
		});
	});

	it("atomically claims an errored rollback retry", async () => {
		mocks.deploymentSubmissionInsert.mockReturnValue({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => ({
					returning: vi.fn().mockResolvedValue([]),
				})),
			})),
		});
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "rollback-rollback-id",
			logPath: "/previous.log",
			status: "error",
		});
		mocks.deploymentRetryReturning.mockResolvedValue([
			{
				deploymentId: "rollback-rollback-id",
				finishedAt: null,
				logPath: "/previous.log",
				startedAt: "retry-started-at",
				status: "running",
			},
		]);

		await expect(
			createRollbackDeploymentSubmission("rollback-id", "application-id"),
		).resolves.toMatchObject({
			deployment: { status: "running" },
			shouldDispatch: true,
		});
	});

	it("reclaims a rollback cancelled by process restart", async () => {
		mocks.deploymentSubmissionInsert.mockReturnValue({
			values: vi.fn(() => ({
				onConflictDoNothing: vi.fn(() => ({
					returning: vi.fn().mockResolvedValue([]),
				})),
			})),
		});
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "rollback-rollback-id",
			logPath: "",
			status: "cancelled",
		});
		mocks.deploymentRetryReturning.mockResolvedValue([
			{
				deploymentId: "rollback-rollback-id",
				logPath: "",
				startedAt: "restart-retry",
				status: "running",
			},
		]);

		await expect(
			createRollbackDeploymentSubmission("rollback-id", "application-id"),
		).resolves.toMatchObject({ shouldDispatch: true });
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
		expect(persistedContext()).toEqual(
			expect.objectContaining({ sourceRevision }),
		);
	});

	it("persists a live resolved revision for source-native rollback", async () => {
		await createRollback({
			appName: "frontend-stg",
			deploymentId: "deployment-id",
			fullContext: {
				buildRegistry: null,
				buildRegistryId: null,
				deployments: [],
				labelsSwarm: {
					"otel.service.version": "${DOKPLOY_SOURCE_REVISION}",
				},
				registry: null,
				registryId: null,
				rollbackRegistry: null,
				rollbackRegistryId: null,
				serverId: null,
				sourceType: "github",
			} as never,
			rollbackSource: {
				image: "frontend-stg:latest",
				labels: { "otel.service.version": sourceRevision },
			},
		});

		expect(mocks.getImageConfig).not.toHaveBeenCalled();
		expect(persistedContext()).toEqual(
			expect.objectContaining({ sourceRevision }),
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
				authConfig: {
					password: "baseline-password",
					serveraddress: "baseline.example.com",
					username: "baseline-user",
				},
				image: baselineImage,
				labels: { "otel.service.version": sourceRevision },
			},
		});

		expect(mocks.getImageConfig).not.toHaveBeenCalled();
		expect(persistedContext()).toEqual(
			expect.objectContaining({
				buildRegistry: null,
				buildRegistryId: null,
				dockerImage: baselineImage,
				labelsSwarm: { "otel.service.version": sourceRevision },
				password: "baseline-password",
				registry: null,
				registryId: null,
				registryUrl: "baseline.example.com",
				username: "baseline-user",
			}),
		);
		expect(
			JSON.stringify(mocks.persistedRollback.mock.calls.at(-1)?.[0]),
		).not.toContain("baseline-password");
	});

	it("stores the same application snapshot used by the candidate deployment", async () => {
		await createRollback({
			appName: "crawl4ai-production",
			deploymentId: "deployment-id",
			fullContext: {
				buildRegistry: null,
				buildRegistryId: null,
				deployments: [],
				dockerImage: candidateImage,
				github: null,
				labelsSwarm: { "otel.service.version": "candidate" },
				memoryLimit: "captured-limit",
				registry: null,
				registryId: null,
				rollbackRegistry: null,
				rollbackRegistryId: null,
				serverId: null,
				sourceType: "docker",
			} as never,
			rollbackSource: {
				image: baselineImage,
				labels: { "otel.service.version": sourceRevision },
			},
		});

		expect(mocks.findApplicationById).not.toHaveBeenCalled();
		expect(persistedContext()).toEqual(
			expect.objectContaining({
				dockerImage: baselineImage,
				memoryLimit: "captured-limit",
			}),
		);
	});

	it("restores the complete immutable Docker service spec", async () => {
		mocks.getRemoteDocker.mockResolvedValue({});
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
		const encryptedContext = {
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
		};
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				application: { appName: "crawl4ai", serverId: null },
			},
			deploymentId: "deployment-id",
			fullContext: {
				encrypted: encryptValue(JSON.stringify(encryptedContext)),
			},
			image: "crawl4ai:v3",
			rollbackId: "rollback-id",
		});
		await rollback("rollback-id");

		expect(mocks.updateSwarmService).toHaveBeenCalledWith(
			expect.anything(),
			"crawl4ai",
			expect.objectContaining({
				EndpointSpec: { Mode: "vip", Ports: [] },
				TaskTemplate: expect.objectContaining({
					ContainerSpec: expect.objectContaining({
						Args: ["--serve"],
						Command: ["python", "server.py"],
						Image: baselineImage,
						Labels: {
							"dokploy.deployment.id": "rollback-rollback-id",
							"otel.service.version": sourceRevision,
						},
						Mounts: [
							{
								Source: "/files/config",
								Target: "/app/config",
								Type: "bind",
							},
						],
						StopGracePeriod: 390_000_000_000,
					}),
				}),
			}),
		);
	});

	it("uses the immutable source image credentials instead of rollback storage", async () => {
		const sourceAuth = {
			password: "source-password",
			serveraddress: "source-registry.example.com",
			username: "source-user",
		};
		mocks.getRemoteDocker.mockResolvedValue({});
		mocks.resolveServiceNetworks.mockResolvedValue([]);
		mocks.generateBindMounts.mockReturnValue([]);
		mocks.generateVolumeMounts.mockReturnValue([]);
		mocks.generateFileMounts.mockReturnValue([]);
		mocks.prepareEnvironmentVariables.mockReturnValue([]);
		mocks.generateConfigContainer.mockReturnValue({
			Mode: { Replicated: { Replicas: 1 } },
		});
		mocks.getAuthConfig.mockResolvedValue(sourceAuth);
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				application: { appName: "crawl4ai", serverId: null },
			},
			deploymentId: "deployment-id",
			fullContext: {
				appName: "crawl4ai",
				dockerImage: baselineImage,
				env: "",
				environment: { env: "", project: { env: "" } },
				mounts: [],
				ports: [],
				rollbackRegistry: {
					password: "rollback-password",
					registryUrl: "rollback-registry.example.com",
					username: "rollback-user",
				},
				sourceType: "docker",
			},
			image: "crawl4ai:v3",
			rollbackId: "rollback-id",
		});
		await rollback("rollback-id");

		expect(mocks.getAuthConfig).toHaveBeenCalledOnce();
		expect(mocks.safeDockerLoginCommand).toHaveBeenCalledWith(
			sourceAuth.serveraddress,
			sourceAuth.username,
			sourceAuth.password,
		);
		expect(mocks.getRegistryTag).not.toHaveBeenCalled();
		expect(mocks.updateSwarmService).toHaveBeenCalledWith(
			expect.anything(),
			"crawl4ai",
			expect.objectContaining({ authconfig: sourceAuth }),
		);
	});

	it("propagates a terminal Swarm rollback failure", async () => {
		mocks.getRemoteDocker.mockResolvedValue({});
		mocks.resolveServiceNetworks.mockResolvedValue([]);
		mocks.generateBindMounts.mockReturnValue([]);
		mocks.generateVolumeMounts.mockReturnValue([]);
		mocks.generateFileMounts.mockReturnValue([]);
		mocks.prepareEnvironmentVariables.mockReturnValue([]);
		mocks.generateConfigContainer.mockReturnValue({
			Mode: { Replicated: { Replicas: 1 } },
		});
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				application: { appName: "crawl4ai", serverId: null },
			},
			deploymentId: "deployment-id",
			fullContext: {
				appName: "crawl4ai",
				dockerImage: baselineImage,
				env: "",
				environment: { env: "", project: { env: "" } },
				mounts: [],
				ports: [],
				sourceType: "docker",
			},
			image: "crawl4ai:v3",
			rollbackId: "rollback-id",
		});
		mocks.updateSwarmService.mockRejectedValueOnce(
			new Error("Swarm service update rolled back: unhealthy container"),
		);

		await expect(rollback("rollback-id")).rejects.toThrow(
			"Swarm service update rolled back: unhealthy container",
		);
	});

	it("rejects a rollback after its application target changes", async () => {
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				application: { appName: "renamed", serverId: "new-server" },
			},
			fullContext: {
				appName: "crawl4ai",
				serverId: "old-server",
				sourceType: "docker",
			},
			rollbackId: "rollback-id",
		});

		await expect(rollback("rollback-id")).rejects.toThrow(
			"Rollback target has changed since the image was captured",
		);
		expect(mocks.updateSwarmService).not.toHaveBeenCalled();
	});

	it("does not expose registry credentials when rollback login fails", async () => {
		const password = "secret-password";
		mocks.getAuthConfig.mockResolvedValue({
			password,
			serveraddress: "registry.example.com",
			username: "source-user",
		});
		mocks.execAsync.mockRejectedValue(
			new Error(`Command failed: printf %s '${password}' | docker login`),
		);
		mocks.findStoredRollback.mockResolvedValue({
			deployment: {
				application: { appName: "crawl4ai", serverId: null },
			},
			fullContext: {
				appName: "crawl4ai",
				dockerImage: baselineImage,
				env: "",
				environment: { env: "", project: { env: "" } },
				mounts: [],
				ports: [],
				serverId: null,
				sourceType: "docker",
			},
			rollbackId: "rollback-id",
		});

		const error = await rollback("rollback-id").catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Registry authentication failed");
		expect((error as Error).message).not.toContain(password);
	});

	it("redacts Docker login credentials from execution diagnostics", () => {
		const password = "secret' | docker login still-secret";
		const command = `printf %s 'secret'\\'' | docker login still-secret' | docker login registry.example.com -u user --password-stdin`;
		const originalError = new Error(`Command failed: ${command}`);
		const error = new ExecError(
			`Command execution failed: ${originalError.message}`,
			{
				command,
				originalError,
			},
		);

		expect(error.message).not.toContain(password);
		expect(error.command).not.toContain(password);
		expect(error.originalError?.message).not.toContain(password);
		expect(error.getDetailedMessage()).not.toContain(password);
		expect(error.command).toContain("printf %s '***' | docker login");
	});

	it("redacts every Docker login in a compound archival command", () => {
		const command =
			"printf %s 'source-secret' | docker login source.example.com; " +
			"printf %s 'destination-secret' | docker login destination.example.com";
		const error = new ExecError(`Command failed: ${command}`, { command });

		expect(error.getDetailedMessage()).not.toContain("source-secret");
		expect(error.getDetailedMessage()).not.toContain("destination-secret");
		expect(error.getDetailedMessage().match(/'\*\*\*'/g)).toHaveLength(4);
	});
});
