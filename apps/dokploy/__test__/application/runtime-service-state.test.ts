import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getRemoteDocker: vi.fn(),
	inspect: vi.fn(),
	listTasks: vi.fn(),
	readTraefikRuntimeConfig: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: mocks.findFirst },
		},
	},
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

vi.mock("@dokploy/server/setup/traefik-setup", () => ({
	readTraefikRuntimeConfig: mocks.readTraefikRuntimeConfig,
}));

const { findApplicationRuntimeServiceState } = await import(
	"@dokploy/server/services/application"
);

describe("application runtime service state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findFirst.mockResolvedValue({
			applicationId: "application-id",
			appName: "crawl4ai",
			name: "crawl4ai-production",
			serverId: "server-id",
			environment: { project: { organizationId: "organization-id" } },
		});
		mocks.getRemoteDocker.mockResolvedValue({
			getService: vi.fn(() => ({ inspect: mocks.inspect })),
			listTasks: mocks.listTasks,
		});
		mocks.listTasks.mockResolvedValue([
			{
				ID: "task-id",
				Slot: 1,
				NodeID: "node-id",
				DesiredState: "running",
				Status: {
					State: "running",
					Timestamp: "2026-08-28T00:00:00Z",
					Message: "secret-task-message",
					ContainerStatus: {
						ContainerID: "container-id",
						PID: 42,
					},
				},
				NetworksAttachments: [
					{
						Network: { Spec: { Name: "dokploy-network" } },
						Addresses: ["10.0.0.11/24"],
					},
				],
			},
			{
				ID: "draining-task-id",
				Slot: 2,
				NodeID: "draining-node-id",
				DesiredState: "shutdown",
				Status: {
					State: "running",
					Timestamp: "2026-08-28T00:01:00Z",
					ContainerStatus: { ContainerID: "draining-container-id" },
				},
			},
			{
				ID: "historical-task-id",
				Slot: 3,
				NodeID: "historical-node-id",
				DesiredState: "shutdown",
				Status: {
					State: "shutdown",
					Timestamp: "2026-08-27T00:00:00Z",
					ContainerStatus: { ContainerID: "historical-container-id" },
				},
			},
		]);
		mocks.readTraefikRuntimeConfig.mockResolvedValue({
			routers: {
				"crawl4ai-7-web@swarm": {
					service: "crawl4ai-7@swarm",
					status: "enabled",
				},
				"another-service@swarm": {
					service: "another-service@swarm",
					status: "enabled",
				},
				"crawl4ai-router-old@file": {
					service: "crawl4ai-service-old@file",
					status: "enabled",
				},
			},
			services: {
				"crawl4ai-7@swarm": {
					status: "enabled",
					serverStatus: {
						"http://token:secret-server-url@10.0.0.11:11235": "UP",
					},
				},
				"another-service@swarm": {
					status: "enabled",
					serverStatus: {
						"http://secret-other-service@10.0.0.99:8080": "UP",
					},
				},
				"crawl4ai-service-old@file": {
					status: "enabled",
					serverStatus: {
						"http://token:secret-file-route@legacy-crawl4ai:11235": "UP",
					},
				},
			},
		});
		mocks.inspect.mockResolvedValue({
			ID: "service-id",
			Version: { Index: 9 },
			Spec: {
				Name: "crawl4ai",
				Labels: {
					"traefik.enable": "true",
					"traefik.http.routers.crawl4ai-7-web.rule":
						"Host(`crawl.example.com`)",
					"traefik.http.services.crawl4ai-7.loadbalancer.server.port": "11235",
					"credential.api-key": "secret-root-label",
					"traefik.http.routers.crawl4ai-7-web.api-key": "secret-router-label",
					"traefik.http.services.crawl4ai-7.loadbalancer.healthcheck.headers.Authorization":
						"secret-service-label",
					"traefik.http.routers.another-service.token": "secret-other-route",
				},
				TaskTemplate: {
					ContainerSpec: {
						Image: "registry.example/crawl4ai@sha256:digest",
						Env: ["API_TOKEN=secret-environment"],
						Labels: {
							"otel.service.name": "crawl4ai",
							"otel.deployment.environment.name": "production",
							"otel.service.version": "revision",
							"credential.api-key": "secret-task-label",
						},
						HealthCheck: {
							Test: [
								"CMD",
								"curl",
								"-f",
								"http://localhost:11235/health/route",
							],
							Interval: 1,
							Timeout: 2,
							StartPeriod: 3,
							Retries: 4,
						},
						StopGracePeriod: 390_000_000_000,
						Mounts: [
							{
								Type: "volume",
								Source: "crawl-data",
								Target: "/data",
								ReadOnly: false,
							},
							{
								Type: "bind",
								Source: "/host/secret-file",
								Target: "/run/secret-file",
							},
						],
						Secrets: [{ SecretName: "secret-service-token" }],
					},
					Networks: [
						{
							Target: "dokploy-network",
							Aliases: ["crawl4ai"],
							DriverOpts: { token: "secret-network-option" },
						},
					],
					RestartPolicy: { Condition: "any", Delay: 1 },
					Placement: {
						Constraints: ["node.role==worker"],
						MaxReplicas: 1,
					},
				},
				Mode: { Replicated: { Replicas: 3 } },
				UpdateConfig: {
					Parallelism: 1,
					FailureAction: "rollback",
					Order: "start-first",
				},
				RollbackConfig: {
					Parallelism: 1,
					FailureAction: "pause",
					Order: "start-first",
				},
			},
			UpdateStatus: {
				State: "completed",
				Message: "secret-update-message",
			},
			ServiceStatus: { RunningTasks: 3, DesiredTasks: 3, CompletedTasks: 0 },
		});
	});

	it("returns only the explicit secret-free application and service projection", async () => {
		const state = await findApplicationRuntimeServiceState(
			"application-id",
			"organization-id",
		);

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				columns: {
					applicationId: true,
					appName: true,
					name: true,
					serverId: true,
				},
			}),
		);
		expect(state.service.rootLabels).toEqual({
			"traefik.enable": "true",
			"traefik.http.routers.crawl4ai-7-web.rule": "Host(`crawl.example.com`)",
			"traefik.http.services.crawl4ai-7.loadbalancer.server.port": "11235",
		});
		expect(state.service.versionIndex).toBe(9);
		expect(state.service.taskLabels).toEqual({
			"otel.service.name": "crawl4ai",
			"otel.deployment.environment.name": "production",
			"otel.service.version": "revision",
		});
		expect(state.service.healthCheck).toEqual({
			Test: ["CMD", "curl", "-f", "http://localhost:11235/health/route"],
			Interval: 1,
			Timeout: 2,
			StartPeriod: 3,
			Retries: 4,
		});
		expect(state.tasks).toEqual([
			{
				taskId: "task-id",
				slot: 1,
				nodeId: "node-id",
				desiredState: "running",
				status: {
					state: "running",
					timestamp: "2026-08-28T00:00:00Z",
					containerId: "container-id",
				},
				addresses: ["10.0.0.11/24"],
			},
			{
				taskId: "draining-task-id",
				slot: 2,
				nodeId: "draining-node-id",
				desiredState: "shutdown",
				status: {
					state: "running",
					timestamp: "2026-08-28T00:01:00Z",
					containerId: "draining-container-id",
				},
				addresses: [],
			},
		]);
		expect(state.service.networks).toEqual([
			{ Target: "dokploy-network", Aliases: ["crawl4ai"] },
		]);
		expect(state.service.volumeMounts).toEqual([
			{
				Type: "volume",
				Source: "crawl-data",
				Target: "/data",
				ReadOnly: false,
			},
		]);
		expect(state.traefik).toEqual({
			routers: [
				{
					routerId: "crawl4ai-7-web@swarm",
					status: "enabled",
					service: "crawl4ai-7@swarm",
				},
				{
					routerId: "crawl4ai-router-old@file",
					status: "enabled",
					service: "crawl4ai-service-old@file",
				},
			],
			services: [
				{
					serviceId: "crawl4ai-7@swarm",
					status: "enabled",
					serverStatus: { "http://10.0.0.11:11235": "UP" },
				},
				{
					serviceId: "crawl4ai-service-old@file",
					status: "enabled",
					serverStatus: { "http://legacy-crawl4ai:11235": "UP" },
				},
			],
		});
		expect(JSON.stringify(state)).not.toContain("secret-");
		expect(JSON.stringify(state)).not.toContain("API_TOKEN");
		expect(JSON.stringify(state)).not.toContain("secret-task-message");
	});

	it("redacts non-local health commands", async () => {
		mocks.inspect.mockResolvedValueOnce({
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						HealthCheck: {
							Test: ["CMD", "curl", "-H", "Authorization: secret"],
						},
					},
				},
			},
		});

		const state = await findApplicationRuntimeServiceState(
			"application-id",
			"organization-id",
		);

		expect(state.service.healthCheck?.Test).toBeNull();
		expect(JSON.stringify(state)).not.toContain("Authorization: secret");
	});

	it("rejects another organization before inspecting Docker", async () => {
		await expect(
			findApplicationRuntimeServiceState("application-id", "another-org"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mocks.getRemoteDocker).not.toHaveBeenCalled();
	});
});
