import { SWARM_READINESS_TRAEFIK_IMAGE } from "@dokploy/server/setup/traefik-setup";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import { sourceRevisionLabelPlaceholder } from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockCreateServiceOptions = {
	Labels?: Record<string, string>;
	TaskTemplate?: {
		ContainerSpec?: {
			Labels?: Record<string, string>;
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	[key: string]: unknown;
};

const {
	assertSwarmReadinessTraefikRuntimeMock,
	inspectMock,
	getServiceMock,
	createServiceMock,
	getRemoteDockerMock,
} = vi.hoisted(() => {
	const assertSwarmReadinessTraefikRuntime = vi.fn();
	const inspect = vi.fn<() => Promise<never>>();
	const getService = vi.fn(() => ({ inspect }));
	const createService = vi.fn<
		(opts: MockCreateServiceOptions) => Promise<void>
	>(async () => undefined);
	const getRemoteDocker = vi.fn(async () => ({
		getService,
		createService,
	}));
	return {
		assertSwarmReadinessTraefikRuntimeMock: assertSwarmReadinessTraefikRuntime,
		inspectMock: inspect,
		getServiceMock: getService,
		createServiceMock: createService,
		getRemoteDockerMock: getRemoteDocker,
	};
});

vi.mock("@dokploy/server/setup/traefik-setup", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/setup/traefik-setup")
	>("@dokploy/server/setup/traefik-setup");
	return {
		...actual,
		assertSwarmReadinessTraefikRuntime: assertSwarmReadinessTraefikRuntimeMock,
	};
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

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
		domains: [],
		readinessCheckSwarm: null,
		redirects: [],
		security: [],
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		vi.stubEnv("TRAEFIK_IMAGE", SWARM_READINESS_TRAEFIK_IMAGE);
		assertSwarmReadinessTraefikRuntimeMock.mockReset();
		assertSwarmReadinessTraefikRuntimeMock.mockResolvedValue(undefined);
		inspectMock.mockReset();
		inspectMock.mockRejectedValue(new Error("service not found"));
		getServiceMock.mockClear();
		createServiceMock.mockClear();
		getRemoteDockerMock.mockClear();
		getRemoteDockerMock.mockResolvedValue({
			getService: getServiceMock,
			createService: createServiceMock,
		});
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
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

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
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

		await mechanizeDockerContainer(application, firstRevision);
		await mechanizeDockerContainer(application, secondRevision);

		const firstSettings = createServiceMock.mock.calls[0]?.[0];
		const secondSettings = createServiceMock.mock.calls[1]?.[0];
		expect(firstSettings?.TaskTemplate?.ContainerSpec?.Labels).toEqual({
			"org.opencontainers.image.revision": firstRevision,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
		expect(secondSettings?.TaskTemplate?.ContainerSpec?.Labels).toEqual({
			"org.opencontainers.image.revision": secondRevision,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
		expect(labelsSwarm).toEqual({
			"org.opencontainers.image.revision": sourceRevisionLabelPlaceholder,
			"test.partial": `prefix-${sourceRevisionLabelPlaceholder}`,
			"test.static": "unchanged",
		});
		expect(firstSettings?.Labels).toBeUndefined();
	});

	it("keeps task labels separate from Dokploy-owned readiness routing labels", async () => {
		const application = createApplication({
			appName: "crawl4ai",
			labelsSwarm: { "otel.service.name": "crawl4ai" },
			readinessCheckSwarm: {
				Path: "/health",
				Interval: 500_000_000,
				UnhealthyInterval: 250_000_000,
				Timeout: 400_000_000,
				Status: 200,
			},
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
		});

		await mechanizeDockerContainer(application);

		const settings = createServiceMock.mock.calls[0]?.[0];
		expect(settings?.TaskTemplate?.ContainerSpec?.Labels).toEqual({
			"otel.service.name": "crawl4ai",
		});
		expect(settings?.Labels).toMatchObject({
			"traefik.enable": "true",
			"traefik.swarm.lbswarm": "false",
			"traefik.http.routers.crawl4ai-7-web.service": "crawl4ai-7@swarm",
			"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.initialstatus":
				"down",
		});
		expect(JSON.stringify(settings?.Labels)).not.toContain("compose-only-name");
	});

	it("rejects readiness before deployment when the task omits the ingress network", async () => {
		const application = createApplication({
			readinessCheckSwarm: {
				Path: "/health",
				Interval: 500_000_000,
				UnhealthyInterval: 250_000_000,
				Timeout: 400_000_000,
				Status: 200,
			},
			networkSwarm: [{ Target: "isolated" }],
		});

		await expect(mechanizeDockerContainer(application)).rejects.toThrow(
			"requires the dokploy-network ingress network",
		);
		expect(createServiceMock).not.toHaveBeenCalled();
	});

	it("rejects unresolved or malformed source revision labels before creating a service", async () => {
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
		expect(createServiceMock).not.toHaveBeenCalled();
		expect(getServiceMock).not.toHaveBeenCalled();
	});
});
