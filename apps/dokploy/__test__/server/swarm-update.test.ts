import {
	DEPLOYMENT_ID_LABEL,
	getSwarmServiceUpdateTimeoutMs,
	updateSwarmService,
	waitForSwarmServiceUpdate,
} from "@dokploy/server/utils/docker/swarm-update";
import { describe, expect, it, vi } from "vitest";

type DockerClient = Parameters<typeof waitForSwarmServiceUpdate>[0];
type DockerService = Parameters<typeof waitForSwarmServiceUpdate>[1];

const service = (
	inspects: Array<Record<string, unknown>>,
	id = "service-id",
) => {
	const inspect = vi.fn();
	for (const value of inspects) inspect.mockResolvedValueOnce(value);
	return { id, inspect, update: vi.fn(async () => undefined) };
};

const task = (
	state: string,
	forceUpdate = 4,
	operationId?: string,
	detail?: string,
) => ({
	Spec: {
		ForceUpdate: forceUpdate,
		...(operationId && {
			ContainerSpec: { Labels: { [DEPLOYMENT_ID_LABEL]: operationId } },
		}),
	},
	Status: { State: state, ...(detail && { Err: detail }) },
});

const settings = (operationId?: string) => ({
	Mode: { Replicated: { Replicas: 1 } },
	TaskTemplate: {
		ContainerSpec: {
			Image: "image",
			...(operationId && {
				Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
			}),
		},
	},
});

describe("updateSwarmService", () => {
	it("waits for the updated service's running task", async () => {
		const swarmService = service([
			{
				ServiceStatus: { DesiredTasks: 1 },
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				Version: { Index: 10 },
			},
			{
				Spec: { TaskTemplate: { ForceUpdate: 4 } },
				UpdateStatus: { State: "completed", StartedAt: "operation-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [task("running")]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings()),
		).resolves.toBeUndefined();
		expect(swarmService.update).toHaveBeenCalledWith(
			expect.objectContaining({
				abortSignal: expect.any(AbortSignal),
				TaskTemplate: expect.objectContaining({ ForceUpdate: 4 }),
				version: 10,
			}),
		);
		expect(swarmService.inspect).toHaveBeenCalledWith(
			expect.objectContaining({ abortSignal: expect.anything() }),
		);
	});

	it("creates only after a 404 with explicit registry authentication", async () => {
		const operationId = "rollback-id";
		const inspect = vi
			.fn()
			.mockRejectedValueOnce({ statusCode: 404 })
			.mockResolvedValueOnce({
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 0,
					},
				},
				Version: { Index: 1 },
			})
			.mockResolvedValueOnce({
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 0,
					},
				},
				Version: { Index: 1 },
			});
		const swarmService = {
			id: "service-id",
			inspect,
			update: vi.fn(),
		};
		const createService = vi.fn(async () => undefined);
		const docker = {
			createService,
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [task("running", 0, operationId)]),
		} as unknown as DockerClient;
		const authConfig = {
			password: "password",
			serveraddress: "registry.example.com",
			username: "user",
		};
		const createSettings = { ...settings(operationId), authconfig: authConfig };

		await expect(
			updateSwarmService(docker, "test-service", createSettings),
		).resolves.toBeUndefined();
		expect(createService).toHaveBeenCalledWith(
			authConfig,
			expect.objectContaining({
				...createSettings,
				abortSignal: expect.any(AbortSignal),
			}),
		);
		expect(swarmService.update).not.toHaveBeenCalled();
	});

	it("resumes an exact matching create after a name conflict", async () => {
		const operationId = "rollback-id";
		const current = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 0,
				},
			},
			Version: { Index: 1 },
		};
		const inspect = vi
			.fn()
			.mockRejectedValueOnce({ statusCode: 404 })
			.mockResolvedValue(current);
		const swarmService = { id: "service-id", inspect, update: vi.fn() };
		const createService = vi.fn().mockRejectedValue({ statusCode: 409 });
		const docker = {
			createService,
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [task("running", 0, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).not.toHaveBeenCalled();
	});

	it("reconciles a lost create response when the exact service committed", async () => {
		const operationId = "rollback-id";
		const current = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 0,
				},
			},
			Version: { Index: 1 },
		};
		const inspect = vi
			.fn()
			.mockRejectedValueOnce({ statusCode: 404 })
			.mockResolvedValue(current);
		const swarmService = { id: "service-id", inspect, update: vi.fn() };
		const createService = vi
			.fn()
			.mockRejectedValue(new Error("connection reset"));
		const docker = {
			createService,
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [task("running", 0, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).not.toHaveBeenCalled();
	});

	it("propagates an inspect error other than 404", async () => {
		const swarmService = {
			inspect: vi.fn().mockRejectedValue({ statusCode: 500 }),
		};
		const createService = vi.fn();
		const docker = {
			createService,
			getService: vi.fn(() => swarmService),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings()),
		).rejects.toEqual({ statusCode: 500 });
		expect(createService).not.toHaveBeenCalled();
	});

	it("resumes a matching operation without a second update", async () => {
		const operationId = "rollback-id";
		const completed = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			UpdateStatus: { State: "completed", StartedAt: "operation-1" },
			Version: { Index: 11 },
		};
		const swarmService = service([completed, completed]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [
				{
					...task("failed", 4, operationId),
					DesiredState: "shutdown",
					ID: "old",
					Slot: 1,
					Version: { Index: 1 },
				},
				{
					...task("running", 4, operationId),
					DesiredState: "running",
					ID: "current",
					Slot: 1,
					Version: { Index: 2 },
				},
			]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).not.toHaveBeenCalled();
	});

	it("uses the current stable rollback policy before submitting an update", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const swarmService = service([
			{
				PreviousSpec: { RollbackConfig: { Delay: 1_000_000_000 } },
				Spec: {
					RollbackConfig: { Delay: 600_000_000_000 },
					TaskTemplate: { ForceUpdate: 3 },
				},
				Version: { Index: 10 },
			},
			{
				Spec: { TaskTemplate: { ForceUpdate: 4 } },
				UpdateStatus: { State: "completed", StartedAt: "operation-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => [task("running")]),
		} as unknown as DockerClient;

		await updateSwarmService(docker, "test-service", settings());

		expect(timeout).toHaveBeenCalledWith(1_311_000);
		timeout.mockRestore();
	});

	it("retries a failed operation with a new force-update generation", async () => {
		const operationId = "rollback-id";
		const failed = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			Version: { Index: 11 },
		};
		const swarmService = service([
			failed,
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 5,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "operation-2" },
				Version: { Index: 12 },
			},
		]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([
					task("failed", 4, operationId, "candidate failed"),
				])
				.mockResolvedValueOnce([
					task("failed", 4, operationId, "candidate failed"),
				])
				.mockResolvedValueOnce([task("running", 5, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).toHaveBeenCalledWith(
			expect.objectContaining({
				TaskTemplate: expect.objectContaining({ ForceUpdate: 5 }),
			}),
		);
	});

	it("advances past a failed generation restored by automatic rollback", async () => {
		const operationId = "rollback-id";
		const swarmService = service([
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: "baseline-id" },
						},
						ForceUpdate: 3,
					},
				},
				UpdateStatus: { State: "rollback_completed" },
				Version: { Index: 12 },
			},
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 5,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "operation-2" },
				Version: { Index: 13 },
			},
		]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([
					task("failed", 4, operationId, "candidate failed"),
				])
				.mockResolvedValueOnce([task("running", 5, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).toHaveBeenCalledWith(
			expect.objectContaining({
				TaskTemplate: expect.objectContaining({ ForceUpdate: 5 }),
			}),
		);
	});

	it("resumes the matching operation after a version conflict", async () => {
		const operationId = "rollback-id";
		const current = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			UpdateStatus: { State: "completed", StartedAt: "operation-1" },
			Version: { Index: 11 },
		};
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				Version: { Index: 10 },
			},
			current,
			current,
		]);
		swarmService.update.mockRejectedValueOnce({ statusCode: 409 });
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([task("running", 4, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).toHaveBeenCalledOnce();
	});

	it("rejects a version conflict that reused the operation label", async () => {
		const operationId = "rollback-id";
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				Version: { Index: 10 },
			},
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 5,
					},
				},
				Version: { Index: 11 },
			},
		]);
		const conflict = { statusCode: 409 };
		swarmService.update.mockRejectedValueOnce(conflict);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi.fn(async () => []),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).rejects.toBe(conflict);
	});

	it("reconciles a lost update response when the exact operation committed", async () => {
		const operationId = "rollback-id";
		const current = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			UpdateStatus: { State: "completed", StartedAt: "operation-1" },
			Version: { Index: 11 },
		};
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				Version: { Index: 10 },
			},
			current,
			current,
		]);
		swarmService.update.mockRejectedValueOnce(new Error("connection reset"));
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([task("running", 4, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "test-service", settings(operationId)),
		).resolves.toBeUndefined();
		expect(swarmService.update).toHaveBeenCalledOnce();
	});

	it("waits for job tasks to complete", async () => {
		const operationId = "job-id";
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				Version: { Index: 10 },
			},
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 4,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "job-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			getService: vi.fn(() => swarmService),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([task("complete", 4, operationId)]),
		} as unknown as DockerClient;
		const jobSettings = {
			...settings(operationId),
			Mode: { ReplicatedJob: { TotalCompletions: 1 } },
		};

		await expect(
			updateSwarmService(docker, "test-service", jobSettings),
		).resolves.toBeUndefined();
	});

	it("uses completed status when ReplicatedJob omits total completions", async () => {
		const operationId = "job-id";
		const swarmService = service(
			[
				{ Spec: { TaskTemplate: { ForceUpdate: 3 } }, Version: { Index: 10 } },
				{
					Spec: {
						TaskTemplate: {
							ContainerSpec: {
								Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
							},
							ForceUpdate: 4,
						},
					},
					UpdateStatus: { State: "completed", StartedAt: "job-1" },
					Version: { Index: 11 },
				},
			],
			"named-job",
		);
		const docker = {
			getService: vi.fn(() => swarmService),
			listNodes: vi.fn(async () => [
				{ Spec: { Availability: "active" }, Status: { State: "ready" } },
			]),
			listServices: vi.fn(async () => [
				{ ServiceStatus: { CompletedTasks: 1, DesiredTasks: 1 } },
			]),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([task("complete", 4, operationId)]),
		} as unknown as DockerClient;

		await expect(
			updateSwarmService(docker, "named-job", {
				...settings(operationId),
				Mode: { ReplicatedJob: {} },
			}),
		).resolves.toBeUndefined();
	});

	it("uses status-enabled service counts for a named Global service", async () => {
		const operationId = "global-id";
		const swarmService = service(
			[
				{ Spec: { TaskTemplate: { ForceUpdate: 3 } }, Version: { Index: 10 } },
				{
					Spec: {
						TaskTemplate: {
							ContainerSpec: {
								Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
							},
							ForceUpdate: 4,
						},
					},
					UpdateStatus: { State: "completed", StartedAt: "global-1" },
					Version: { Index: 11 },
				},
			],
			"named-service",
		);
		const currentTasks = ["node-1", "node-2"].map((NodeID) => ({
			...task("running", 4, operationId),
			NodeID,
			Slot: 0,
		}));
		const docker = {
			getService: vi.fn(() => swarmService),
			listNodes: vi.fn(async () => [
				{ Spec: { Availability: "active" }, Status: { State: "ready" } },
				{ Spec: { Availability: "active" }, Status: { State: "ready" } },
			]),
			listServices: vi.fn(async () => [{ ServiceStatus: { DesiredTasks: 2 } }]),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(currentTasks),
		} as unknown as DockerClient;

		await updateSwarmService(docker, "named-service", {
			...settings(operationId),
			Mode: { Global: {} },
		});
		expect(docker.listServices).toHaveBeenCalledWith(
			expect.objectContaining({
				filters: JSON.stringify({ name: ["named-service"] }),
				status: true,
			}),
		);
	});

	it("counts completed tasks for a named GlobalJob service", async () => {
		const operationId = "global-job-id";
		const swarmService = service(
			[
				{ Spec: { TaskTemplate: { ForceUpdate: 3 } }, Version: { Index: 10 } },
				{
					Spec: {
						TaskTemplate: {
							ContainerSpec: {
								Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
							},
							ForceUpdate: 4,
						},
					},
					UpdateStatus: { State: "completed", StartedAt: "job-1" },
					Version: { Index: 11 },
				},
			],
			"named-job",
		);
		const currentTasks = ["node-1", "node-2"].map((NodeID) => ({
			...task("complete", 4, operationId),
			NodeID,
			Slot: 0,
		}));
		const docker = {
			getService: vi.fn(() => swarmService),
			listNodes: vi.fn(async () => [
				{ Spec: { Availability: "active" }, Status: { State: "ready" } },
				{ Spec: { Availability: "active" }, Status: { State: "ready" } },
			]),
			listServices: vi.fn(async () => [
				{ ServiceStatus: { CompletedTasks: 2, DesiredTasks: 0 } },
			]),
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(currentTasks),
		} as unknown as DockerClient;

		await updateSwarmService(docker, "named-job", {
			...settings(operationId),
			Mode: { GlobalJob: {} },
		});
		expect(swarmService.update).toHaveBeenCalledWith(
			expect.objectContaining({
				TaskTemplate: expect.objectContaining({ ForceUpdate: 4 }),
			}),
		);
	});
});

describe("waitForSwarmServiceUpdate", () => {
	it("does not accept an unlabeled operation that reused the force update", async () => {
		const operationId = "rollback-id";
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 4 } },
				UpdateStatus: { State: "completed", StartedAt: "operation-2" },
				Version: { Index: 12 },
			},
		]);
		const docker = { listTasks: vi.fn() } as unknown as DockerClient;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					previousVersion: 10,
					timeoutMs: 1_000,
				},
			),
		).rejects.toThrow("superseded by another operation");
	});

	it("does not accept a running job task as completed", async () => {
		const operationId = "job-id";
		const swarmService = service([
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 4,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "job-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			listTasks: vi.fn(async () => [task("running", 4, operationId)]),
		} as unknown as DockerClient;
		let now = 0;
		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					expectedTaskCount: 1,
					isJob: true,
					nowFn: () => now,
					pollIntervalMs: 1,
					previousVersion: 10,
					sleepFn: async (milliseconds) => {
						now += milliseconds;
					},
					timeoutMs: 1,
				},
			),
		).rejects.toThrow("Swarm service update did not finish");
	});

	it("accepts exact zero-task convergence for a scaled-down service", async () => {
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 4 } },
				UpdateStatus: { State: "completed", StartedAt: "operation-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			listTasks: vi.fn(async () => []),
		} as unknown as DockerClient;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedTaskCount: 0,
					previousVersion: 10,
					timeoutMs: 1_000,
				},
			),
		).resolves.toBeUndefined();
	});

	it("reports an automatic rollback with its failed task", async () => {
		const swarmService = service([
			{
				Spec: { TaskTemplate: { ForceUpdate: 3 } },
				UpdateStatus: {
					State: "rollback_completed",
					Message: "rollback completed",
					StartedAt: "operation-1",
				},
				Version: { Index: 12 },
			},
		]);
		const docker = {
			listTasks: vi.fn(async () => [
				task("failed", 4, undefined, "task: unhealthy container"),
			]),
		} as unknown as DockerClient;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					previousVersion: 10,
					timeoutMs: 1_000,
				},
			),
		).rejects.toThrow(
			"Swarm service update rolled back: rollback completed. Latest task failure: task: unhealthy container",
		);
	});

	it("evaluates only the latest task in each replica slot", async () => {
		const operationId = "rollback-id";
		const swarmService = service([
			{
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 4,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "operation-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			listTasks: vi.fn(async () => [
				{
					...task("failed", 4, operationId, "old attempt"),
					DesiredState: "shutdown",
					ID: "old",
					Slot: 1,
					Version: { Index: 1 },
				},
				{
					...task("running", 4, operationId),
					DesiredState: "running",
					ID: "current",
					Slot: 1,
					Version: { Index: 2 },
				},
			]),
		} as unknown as DockerClient;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					expectedTaskCount: 1,
					previousVersion: 10,
					timeoutMs: 1_000,
				},
			),
		).resolves.toBeUndefined();
	});

	it("counts current global tasks by node instead of slot zero", async () => {
		const operationId = "global-id";
		const swarmService = service([
			{
				ServiceStatus: { DesiredTasks: 2 },
				Spec: {
					TaskTemplate: {
						ContainerSpec: {
							Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
						},
						ForceUpdate: 4,
					},
				},
				UpdateStatus: { State: "completed", StartedAt: "operation-1" },
				Version: { Index: 11 },
			},
		]);
		const docker = {
			listTasks: vi.fn(async () => [
				{
					...task("running", 4, operationId),
					NodeID: "node-1",
					Slot: 0,
				},
				{
					...task("running", 4, operationId),
					NodeID: "node-2",
					Slot: 0,
				},
			]),
		} as unknown as DockerClient;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					expectedTaskCount: 2,
					keyTasksByNode: true,
					previousVersion: 10,
					timeoutMs: 1_000,
				},
			),
		).resolves.toBeUndefined();
	});

	it("accepts authoritative zero-task Global convergence", async () => {
		const operationId = "global-id";
		const operation = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			UpdateStatus: { State: "completed", StartedAt: "operation-1" },
			Version: { Index: 11 },
		};
		const swarmService = service([operation]);
		const docker = {
			listTasks: vi.fn().mockResolvedValueOnce([]),
		} as unknown as DockerClient;
		let now = 0;
		const resolveExpectedTaskCount = vi.fn().mockResolvedValueOnce(0);

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					keyTasksByNode: true,
					nowFn: () => now,
					pollIntervalMs: 1,
					previousVersion: 10,
					resolveExpectedTaskCount,
					sleepFn: async (milliseconds) => {
						now += milliseconds;
					},
					timeoutMs: 10,
				},
			),
		).resolves.toBeUndefined();
		expect(docker.listTasks).toHaveBeenCalledOnce();
	});

	it("does not sleep past the remaining wall-clock budget", async () => {
		let now = 0;
		const swarmService = {
			id: "service-id",
			inspect: vi.fn(async () => {
				now = 999;
				return { Version: { Index: 10 } };
			}),
		} as unknown as DockerService;
		const sleepFn = vi.fn(async (milliseconds: number) => {
			now += milliseconds;
		});

		await expect(
			waitForSwarmServiceUpdate({} as DockerClient, swarmService, {
				expectedForceUpdate: 4,
				nowFn: () => now,
				pollIntervalMs: 5_000,
				previousVersion: 10,
				sleepFn,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow("did not finish within 1 seconds");
		expect(sleepFn).toHaveBeenCalledWith(1);
	});

	it("waits for a start-first predecessor to finish draining", async () => {
		const operationId = "deployment-id";
		const operation = {
			Spec: {
				TaskTemplate: {
					ContainerSpec: {
						Labels: { [DEPLOYMENT_ID_LABEL]: operationId },
					},
					ForceUpdate: 4,
				},
			},
			UpdateStatus: { State: "completed", StartedAt: "operation-1" },
			Version: { Index: 11 },
		};
		const swarmService = service([operation, operation]);
		const predecessor = {
			...task("running", 3, "previous-id"),
			ID: "previous",
			Slot: 1,
		};
		const candidate = {
			...task("running", 4, operationId),
			ID: "candidate",
			Slot: 1,
		};
		const docker = {
			listTasks: vi
				.fn()
				.mockResolvedValueOnce([candidate, predecessor])
				.mockResolvedValueOnce([
					candidate,
					{ ...predecessor, Status: { State: "shutdown" } },
				]),
		} as unknown as DockerClient;
		let now = 0;

		await expect(
			waitForSwarmServiceUpdate(
				docker,
				swarmService as unknown as DockerService,
				{
					expectedForceUpdate: 4,
					expectedOperationId: operationId,
					expectedTaskCount: 1,
					nowFn: () => now,
					pollIntervalMs: 1,
					previousVersion: 10,
					sleepFn: async (milliseconds) => {
						now += milliseconds;
					},
					timeoutMs: 10,
				},
			),
		).resolves.toBeUndefined();
		expect(docker.listTasks).toHaveBeenCalledTimes(2);
	});
});

describe("getSwarmServiceUpdateTimeoutMs", () => {
	it("includes every batch delay and the final monitor window", () => {
		expect(
			getSwarmServiceUpdateTimeoutMs({
				replicas: 10,
				rollbackConfig: {
					Delay: 10_000_000_000,
					Monitor: 30_000_000_000,
					Parallelism: 1,
				},
				updateConfig: {
					Delay: 10_000_000_000,
					Monitor: 30_000_000_000,
					Parallelism: 1,
				},
			}),
		).toBe(520_000);
	});

	it("includes health admission and stop-first grace per batch", () => {
		const taskTemplate = {
			ContainerSpec: {
				HealthCheck: {
					Interval: 30_000_000_000,
					Retries: 2,
					StartInterval: 5_000_000_000,
					StartPeriod: 10_000_000_000,
					Timeout: 20_000_000_000,
				},
				StopGracePeriod: 45_000_000_000,
			},
		};

		expect(
			getSwarmServiceUpdateTimeoutMs({
				replicas: 1,
				rollbackConfig: { Monitor: 30_000_000_000, Order: "stop-first" },
				taskTemplate,
				updateConfig: { Monitor: 30_000_000_000, Order: "stop-first" },
			}),
		).toBe(480_000);
	});

	it("includes Docker's default stop grace for every batch", () => {
		expect(
			getSwarmServiceUpdateTimeoutMs({
				replicas: 10,
				rollbackConfig: { Order: "stop-first", Parallelism: 1 },
				updateConfig: { Order: "stop-first", Parallelism: 1 },
			}),
		).toBe(320_000);
	});

	it("includes start-first predecessor drain in both phases", () => {
		expect(
			getSwarmServiceUpdateTimeoutMs({
				replicas: 1,
				rollbackConfig: { Monitor: 30_000_000_000, Order: "start-first" },
				rollbackTaskTemplate: {
					ContainerSpec: { StopGracePeriod: 45_000_000_000 },
				},
				taskTemplate: {
					ContainerSpec: { StopGracePeriod: 45_000_000_000 },
				},
				updateConfig: { Monitor: 30_000_000_000, Order: "start-first" },
			}),
		).toBe(210_000);
	});

	it("keeps long delay rollouts inside the lease budget", () => {
		expect(
			getSwarmServiceUpdateTimeoutMs({
				replicas: 3,
				rollbackConfig: {
					Delay: 1_800_000_000_000,
					Monitor: 1_800_000_000_000,
					Parallelism: 1,
				},
				updateConfig: {
					Delay: 1_800_000_000_000,
					Monitor: 1_800_000_000_000,
					Parallelism: 1,
				},
			}),
		).toBe(14_522_000);
	});

	it("keeps small updates above the minimum", () => {
		expect(getSwarmServiceUpdateTimeoutMs({ replicas: 1 })).toBe(140_000);
	});

	it("gives Swarm jobs a finite completion window", () => {
		expect(getSwarmServiceUpdateTimeoutMs({ isJob: true, replicas: 1 })).toBe(
			86_400_000,
		);
	});
});
