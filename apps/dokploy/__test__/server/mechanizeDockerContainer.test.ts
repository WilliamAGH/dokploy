import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import { sourceRevisionLabelPlaceholder } from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockSwarmServiceSettings = {
	TaskTemplate?: {
		ContainerSpec?: {
			Image?: string;
			Labels?: Record<string, string>;
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	[key: string]: unknown;
};

const { getRemoteDockerMock, findRegistryMock } = vi.hoisted(() => {
	const getRemoteDocker = vi.fn(async () => ({}));
	const findRegistry = vi.fn();
	return {
		getRemoteDockerMock: getRemoteDocker,
		findRegistryMock: findRegistry,
	};
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

const { updateSwarmServiceMock } = vi.hoisted(() => ({
	updateSwarmServiceMock: vi.fn<
		(
			docker: unknown,
			serviceName: string,
			settings: MockSwarmServiceSettings,
		) => Promise<void>
	>(async () => undefined),
}));

vi.mock("@dokploy/server/utils/docker/swarm-update", () => ({
	DEPLOYMENT_ID_LABEL: "dokploy.deployment.id",
	updateSwarmService: updateSwarmServiceMock,
}));

vi.mock("@dokploy/server/services/registry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/registry")
	>()),
	findRegistryByIdWithCredentials: findRegistryMock,
}));

const settingsAt = (callIndex = 0): MockSwarmServiceSettings => {
	const settings = updateSwarmServiceMock.mock.calls[callIndex]?.[2];
	if (!settings) throw new Error("updateSwarmService should receive settings");
	return settings;
};

const createApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		appName: "test-app",
		buildType: "dockerfile",
		env: null,
		mounts: [],
		cpuLimit: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuReservation: null,
		command: null,
		ports: [],
		sourceType: "docker",
		dockerImage: "example:latest",
		registry: null,
		environment: {
			project: { env: null },
			env: null,
		},
		replicas: 1,
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		getRemoteDockerMock.mockClear();
		findRegistryMock.mockReset();
		updateSwarmServiceMock.mockReset();
		updateSwarmServiceMock.mockResolvedValue(undefined);
		getRemoteDockerMock.mockResolvedValue({});
	});

	it("keeps an exact Docker digest and sends selected registry auth", async () => {
		const digest = `registry.example.com/app@sha256:${"a".repeat(64)}`;
		findRegistryMock.mockResolvedValue({
			username: "registry-user",
			password: "registry-password",
			registryUrl: "registry.example.com",
		});

		await mechanizeDockerContainer(
			createApplication({
				dockerImage: digest,
				registry: { registryId: "registry-id" } as never,
			}),
		);

		const settings = settingsAt();
		expect(settings.authconfig).toEqual({
			username: "registry-user",
			password: "registry-password",
			serveraddress: "registry.example.com",
		});
		expect(settings.TaskTemplate?.ContainerSpec?.Image).toBe(digest);
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await mechanizeDockerContainer(application);

		const settings = settingsAt();
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await mechanizeDockerContainer(application);

		const settings = settingsAt();
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty(
			"StopGracePeriod",
		);
	});

	it("passes ulimits to ContainerSpec when ulimitsSwarm is defined", async () => {
		const ulimits = [
			{ Name: "nofile", Soft: 10000, Hard: 20000 },
			{ Name: "nproc", Soft: 4096, Hard: 8192 },
		];
		const application = createApplication({ ulimitsSwarm: ulimits });

		await mechanizeDockerContainer(application);

		const settings = settingsAt();
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await mechanizeDockerContainer(application);

		const settings = settingsAt();
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await mechanizeDockerContainer(application);

		const settings = settingsAt();
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("passes job mode to the Swarm convergence owner", async () => {
		await mechanizeDockerContainer(
			createApplication({
				modeSwarm: { ReplicatedJob: { TotalCompletions: 1 } },
			}),
		);

		expect(updateSwarmServiceMock).toHaveBeenCalledWith(
			expect.anything(),
			"test-app",
			expect.objectContaining({
				Mode: { ReplicatedJob: { TotalCompletions: 1 } },
			}),
		);
	});

	it("renders the source revision label for each deployment without changing stored labels", async () => {
		const labelsSwarm = {
			"org.opencontainers.image.revision": sourceRevisionLabelPlaceholder,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		};
		const application = createApplication({ labelsSwarm });
		const firstRevision = "0123456789abcdef0123456789abcdef01234567";
		const secondRevision = "89abcdef0123456789abcdef0123456789abcdef";

		await mechanizeDockerContainer(application, firstRevision, "deployment-id");
		await mechanizeDockerContainer(application, secondRevision);

		const firstSettings = settingsAt();
		const secondSettings = settingsAt(1);
		expect(firstSettings.TaskTemplate?.ContainerSpec?.Labels).toEqual({
			"dokploy.deployment.id": "deployment-id",
			"org.opencontainers.image.revision": firstRevision,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
		expect(secondSettings.TaskTemplate?.ContainerSpec?.Labels).toEqual({
			"org.opencontainers.image.revision": secondRevision,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
		expect(labelsSwarm).toEqual({
			"org.opencontainers.image.revision": sourceRevisionLabelPlaceholder,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
	});

	it("rejects unresolved or malformed source revision labels before Swarm submission", async () => {
		const application = createApplication({
			labelsSwarm: {
				"org.opencontainers.image.revision": sourceRevisionLabelPlaceholder,
			},
		});

		await expect(mechanizeDockerContainer(application)).rejects.toThrow(
			"DOKPLOY_SOURCE_REVISION requires a deployment source revision",
		);
		await expect(
			mechanizeDockerContainer(application, "not-a-source-revision"),
		).rejects.toThrow("Source revision must be a lowercase 40-hex SHA");
		expect(updateSwarmServiceMock).not.toHaveBeenCalled();
	});
});
