import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getGroup,
	type InMemoryJob,
	InMemoryQueue,
} from "../../server/queues/in-memory-queue";
import type { DeploymentJob } from "../../server/queues/queue-types";

const mocks = vi.hoisted(() => ({
	cloudMode: { enabled: false },
	createRollbackDeploymentSubmission: vi.fn(),
	deploy: vi.fn(),
	deployApplication: vi.fn(),
	findRollbackById: vi.fn(),
	findServerById: vi.fn(),
	permission: vi.fn(),
	queueAdd: vi.fn(),
	rollback: vi.fn(),
	updateApplicationStatus: vi.fn(),
	updateDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	get IS_CLOUD() {
		return mocks.cloudMode.enabled;
	},
	createRollbackDeploymentSubmission: mocks.createRollbackDeploymentSubmission,
	deployApplication: mocks.deployApplication,
	findRollbackById: mocks.findRollbackById,
	findServerById: mocks.findServerById,
	rollback: mocks.rollback,
	updateApplicationStatus: mocks.updateApplicationStatus,
	updateDeployment: mocks.updateDeployment,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.permission,
}));

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: { add: mocks.queueAdd },
}));

vi.mock("@/server/utils/deploy", () => ({ deploy: mocks.deploy }));

const { rollbackRouter } = await import("@/server/api/routers/rollbacks");
const { processDeploymentJob } = await import(
	"@/server/queues/deployments-queue"
);
const { deploy: processCloudDeployment } = await import(
	"../../../api/src/utils"
);
const { deployJobSchema } = await import("../../../api/src/schema");

const rollbackJob = (
	applicationId = "application-id",
): Extract<DeploymentJob, { type: "rollback" }> & { serverId: string } => ({
	applicationId,
	deploymentId: "rollback-rollback-id",
	rollbackId: "rollback-id",
	titleLog: "Rollback deployment",
	descriptionLog: "",
	type: "rollback",
	applicationType: "application",
	serverId: "server-id",
});

describe("rollback submission", () => {
	const caller = () =>
		rollbackRouter.createCaller({
			session: { activeOrganizationId: "organization-id" },
			user: {
				id: "user-id",
				email: "user@example.com",
				role: "owner",
			},
		} as never);

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cloudMode.enabled = false;
		mocks.deploy.mockResolvedValue(undefined);
		mocks.findRollbackById.mockResolvedValue({
			deployment: {
				applicationId: "application-id",
				application: { serverId: "server-id" },
			},
		});
		mocks.findServerById.mockResolvedValue({ serverStatus: "active" });
		mocks.permission.mockResolvedValue(undefined);
		mocks.queueAdd.mockResolvedValue({ id: "rollback-rollback-id" });
	});

	it("queues the deterministic rollback job", async () => {
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				createdAt: "created-at",
				deploymentId: "rollback-rollback-id",
				logPath: "",
				status: "running",
			},
			shouldDispatch: true,
		});

		await expect(
			caller().rollback({ rollbackId: "rollback-id" }),
		).resolves.toEqual({ deploymentId: "rollback-rollback-id" });

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.objectContaining(rollbackJob()),
			"rollback-rollback-id",
		);
	});

	it("returns a completed rollback deployment without enqueuing it again", async () => {
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "",
				status: "done",
			},
			shouldDispatch: false,
		});

		await expect(
			caller().rollback({ rollbackId: "rollback-id" }),
		).resolves.toEqual({ deploymentId: "rollback-rollback-id" });

		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("requeues a failed self-hosted rollback submission", async () => {
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "/previous.log",
				status: "running",
			},
			shouldDispatch: true,
		});

		await caller().rollback({ rollbackId: "rollback-id" });

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.objectContaining(rollbackJob()),
			"rollback-rollback-id",
		);
	});

	it("replays a durable running cloud dispatch", async () => {
		mocks.cloudMode.enabled = true;
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "",
				startedAt: "attempt-started-at",
				status: "running",
			},
			shouldDispatch: true,
		});

		await caller().rollback({ rollbackId: "rollback-id" });

		expect(mocks.deploy).toHaveBeenCalledWith(
			expect.objectContaining(rollbackJob()),
		);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("rejects cloud rollback without a deployment server", async () => {
		mocks.cloudMode.enabled = true;
		mocks.findRollbackById.mockResolvedValue({
			deployment: {
				applicationId: "application-id",
				application: { serverId: null },
			},
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(
			caller().rollback({ rollbackId: "rollback-id" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createRollbackDeploymentSubmission).not.toHaveBeenCalled();
		expect(mocks.deploy).not.toHaveBeenCalled();
	});

	it("retries a failed cloud rollback submission", async () => {
		mocks.cloudMode.enabled = true;
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "/previous.log",
				status: "running",
			},
			shouldDispatch: true,
		});

		await caller().rollback({ rollbackId: "rollback-id" });

		expect(mocks.deploy).toHaveBeenCalledWith(
			expect.objectContaining(rollbackJob()),
		);
		expect(mocks.queueAdd).not.toHaveBeenCalled();
	});

	it("awaits a rejected cloud dispatch", async () => {
		mocks.cloudMode.enabled = true;
		mocks.createRollbackDeploymentSubmission.mockResolvedValue({
			deployment: {
				deploymentId: "rollback-rollback-id",
				logPath: "",
				status: "running",
			},
			shouldDispatch: true,
		});
		mocks.deploy.mockRejectedValueOnce(new Error("cloud unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(
			caller().rollback({ rollbackId: "rollback-id" }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.deploy).toHaveBeenCalledWith(
			expect.objectContaining(rollbackJob()),
		);
		expect(mocks.updateDeployment).not.toHaveBeenCalled();
	});
});

describe("cloud dispatch response", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rejects non-OK responses without including their body", async () => {
		mocks.findServerById.mockResolvedValue({ serverStatus: "active" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("upstream response body", { status: 503 }),
		);
		const { deploy } = await vi.importActual<
			typeof import("@/server/utils/deploy")
		>("@/server/utils/deploy");

		const error = await deploy(rollbackJob()).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error))
			throw new Error("Expected deployment failure");
		expect(error.message).toBe("Deployment request failed with HTTP 503");
		expect(error.message).not.toContain("upstream response body");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});
});

describe("rollback queue jobs", () => {
	beforeEach(() => vi.clearAllMocks());

	afterEach(() => vi.restoreAllMocks());

	it("shares the application queue group with deployments", async () => {
		let releaseDeployment!: () => void;
		let markDeploymentStarted!: () => void;
		let markRollbackStarted!: () => void;
		const deploymentDone = new Promise<void>((resolve) => {
			releaseDeployment = resolve;
		});
		const deploymentStarted = new Promise<void>((resolve) => {
			markDeploymentStarted = resolve;
		});
		const rollbackStarted = new Promise<void>((resolve) => {
			markRollbackStarted = resolve;
		});
		const started: string[] = [];
		const queue = new InMemoryQueue({ resolveConcurrency: () => 2 });
		queue.process(async (job) => {
			started.push(job.data.type);
			if (job.data.type === "deploy") {
				markDeploymentStarted();
				await deploymentDone;
			} else if (job.data.type === "rollback") {
				markRollbackStarted();
			}
		});

		const deployJob: DeploymentJob = {
			applicationId: "application-id",
			titleLog: "Deploy",
			descriptionLog: "",
			type: "deploy",
			applicationType: "application",
			serverId: "server-id",
		};
		const queuedRollback = rollbackJob();

		expect(getGroup(deployJob)).toBe(getGroup(queuedRollback));
		await queue.add(deployJob);
		await queue.add(queuedRollback);
		await deploymentStarted;
		expect(started).toEqual(["deploy"]);

		releaseDeployment();
		await rollbackStarted;
		expect(started).toEqual(["deploy", "rollback"]);
	});

	it("records a terminal rollback failure on its deployment", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		mocks.rollback.mockRejectedValueOnce(
			new Error("Swarm service update rolled back: unhealthy container"),
		);

		await processDeploymentJob({ data: rollbackJob() } as InMemoryJob);

		expect(mocks.updateDeployment).toHaveBeenNthCalledWith(
			1,
			"rollback-rollback-id",
			expect.objectContaining({
				status: "running",
				finishedAt: null,
				errorMessage: null,
			}),
		);
		expect(mocks.updateApplicationStatus).toHaveBeenNthCalledWith(
			1,
			"application-id",
			"running",
		);
		expect(mocks.updateDeployment).toHaveBeenCalledWith(
			"rollback-rollback-id",
			expect.objectContaining({
				errorMessage: "Swarm service update rolled back: unhealthy container",
				status: "error",
			}),
		);
		expect(mocks.updateApplicationStatus).toHaveBeenLastCalledWith(
			"application-id",
			"error",
		);
	});

	it("marks the rollback deployment and application done after completion", async () => {
		await processDeploymentJob({ data: rollbackJob() } as InMemoryJob);

		expect(mocks.rollback).toHaveBeenCalledWith("rollback-id");
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"rollback-rollback-id",
			"done",
		);
		expect(mocks.updateApplicationStatus).toHaveBeenLastCalledWith(
			"application-id",
			"done",
		);
	});
});

describe("cloud rollback jobs", () => {
	beforeEach(() => vi.clearAllMocks());

	it("requires deterministic rollback identifiers at the HTTP boundary", () => {
		expect(deployJobSchema.safeParse(rollbackJob()).success).toBe(true);
		expect(
			deployJobSchema.safeParse({
				...rollbackJob(),
				deploymentId: undefined,
			}).success,
		).toBe(false);
	});

	it("records terminal rollback success and failure", async () => {
		await processCloudDeployment(rollbackJob());
		expect(mocks.rollback).toHaveBeenCalledWith("rollback-id");
		expect(mocks.updateDeployment).toHaveBeenNthCalledWith(
			1,
			"rollback-rollback-id",
			expect.objectContaining({
				status: "running",
				finishedAt: null,
				errorMessage: null,
			}),
		);
		expect(mocks.updateDeploymentStatus).toHaveBeenCalledWith(
			"rollback-rollback-id",
			"done",
		);

		vi.clearAllMocks();
		mocks.rollback.mockRejectedValueOnce(new Error("rollback failed"));
		await expect(processCloudDeployment(rollbackJob())).rejects.toThrow(
			"rollback failed",
		);
		expect(mocks.updateDeployment).toHaveBeenCalledWith(
			"rollback-rollback-id",
			expect.objectContaining({
				errorMessage: "rollback failed",
				status: "error",
			}),
		);
	});

	it("preserves exact application deployment metadata", async () => {
		await processCloudDeployment({
			applicationId: "application-id",
			applicationType: "application",
			deploymentId: "application-deployment-id",
			descriptionLog: "",
			expectedDockerImage: "registry.example.com/app@sha256:digest",
			expectedLabelsSwarm: { revision: "abc" },
			server: true,
			serverId: "server-id",
			sourceRevision: "0123456789abcdef0123456789abcdef01234567",
			titleLog: "Deploy",
			type: "deploy",
		});

		expect(mocks.deployApplication).toHaveBeenCalledWith(
			expect.objectContaining({
				deploymentId: "application-deployment-id",
				expectedDockerImage: "registry.example.com/app@sha256:digest",
				expectedLabelsSwarm: { revision: "abc" },
			}),
		);
	});
});
