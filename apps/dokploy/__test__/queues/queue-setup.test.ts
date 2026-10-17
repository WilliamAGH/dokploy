import { describe, expect, it, vi } from "vitest";
import type { DeploymentJob } from "../../server/queues/queue-types";

const mocks = vi.hoisted(() => ({
	release: () => {},
	updateDeploymentStatus: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	IS_CLOUD: false,
	updateDeploymentStatus: mocks.updateDeploymentStatus,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("../../server/queues/concurrency", () => ({
	resolveBuildsConcurrency: () => 1,
}));

vi.mock("../../server/queues/deployments-queue", () => ({
	processDeploymentJob: () =>
		new Promise<void>((resolve) => {
			mocks.release = resolve;
		}),
}));

const { cleanQueuesByCompose, myQueue } = await import(
	"../../server/queues/queueSetup"
);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const appJob = (deploymentId: string): DeploymentJob => ({
	applicationId: "app",
	deploymentId,
	titleLog: deploymentId,
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
});

const composeJob = (titleLog: string): DeploymentJob => ({
	composeId: "stack",
	titleLog,
	descriptionLog: "",
	type: "deploy",
	applicationType: "compose",
});

describe("deployment queue setup", () => {
	it("cancels the rows of replaced waiting jobs and never the active one", async () => {
		await myQueue.add(appJob("active"));
		await flush();
		await myQueue.add(appJob("older"), "older");
		await myQueue.add(appJob("newest"), "newest");

		expect(mocks.updateDeploymentStatus.mock.calls).toEqual([
			["older", "cancelled"],
		]);
		expect(
			(await myQueue.getJobs(["waiting"])).map((job) => job.data.titleLog),
		).toEqual(["newest"]);
		expect(
			(await myQueue.getJobs(["active"])).map((job) => job.data.titleLog),
		).toEqual(["active"]);

		myQueue.clearWaiting();
		mocks.release();
		await flush();
	});

	it("removes waiting compose jobs, which own no deployment row yet", async () => {
		mocks.updateDeploymentStatus.mockClear();
		await myQueue.add(composeJob("compose-active"));
		await flush();
		await myQueue.add(composeJob("compose-waiting"));

		await cleanQueuesByCompose("stack");

		expect(await myQueue.getJobs(["waiting"])).toEqual([]);
		expect(mocks.updateDeploymentStatus).not.toHaveBeenCalled();
		mocks.release();
	});

	it("keeps a replaced job out when its retry arrives before its row is cancelled", async () => {
		await flush();
		mocks.updateDeploymentStatus.mockClear();
		let finishCancel!: () => void;
		mocks.updateDeploymentStatus.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishCancel = resolve;
				}),
		);
		await myQueue.add(appJob("busy"));
		await flush();
		await myQueue.add(appJob("stale"), "stale");
		const replacing = myQueue.add(appJob("fresh"), "fresh");

		const retry = await myQueue.add(appJob("stale"), "stale");

		expect(retry).toEqual({ id: "stale" });
		expect(
			(await myQueue.getJobs(["waiting"])).map((job) => job.data.titleLog),
		).toEqual(["fresh"]);
		finishCancel();
		await replacing;
		expect(mocks.updateDeploymentStatus.mock.calls).toEqual([
			["stale", "cancelled"],
		]);

		// A rollback reclaims its cancelled row under the same id and dispatches again.
		await myQueue.add(
			{
				applicationId: "app",
				deploymentId: "stale",
				rollbackId: "rollback",
				titleLog: "stale",
				descriptionLog: "",
				type: "rollback",
				applicationType: "application",
			},
			"stale",
		);
		expect(
			(await myQueue.getJobs(["waiting"])).map((job) => job.data.titleLog),
		).toEqual(["stale"]);

		myQueue.clearWaiting();
		mocks.release();
		await flush();
	});
});
