import { IS_CLOUD, updateDeploymentStatus } from "@dokploy/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { resolveBuildsConcurrency } from "./concurrency";
import { processDeploymentJob } from "./deployments-queue";
import { type InMemoryJob, InMemoryQueue } from "./in-memory-queue";
import type { DeploymentJob } from "./queue-types";

/**
 * Deployment queue.
 *
 * Self-hosted uses an in-memory, per-group FIFO queue with configurable
 * concurrency per server. Cloud does not use the queue at all — deployments
 * run directly in the background — so we expose a no-op.
 */

interface DeploymentQueue {
	add: (data: DeploymentJob, jobId?: string) => Promise<{ id: string }>;
	getJobs: (states?: Array<"waiting" | "active">) => Promise<InMemoryJob[]>;
	close: () => Promise<void>;
	on: (...args: unknown[]) => void;
	run: () => Promise<void>;
	removeWaiting: (predicate: (data: DeploymentJob) => boolean) => number;
	removeWaitingJobs: (predicate: (data: DeploymentJob) => boolean) => DeploymentJob[];
	clearWaiting: () => number;
}

const createNoopQueue = (): DeploymentQueue => ({
	add: () => Promise.resolve({ id: "noop" }),
	getJobs: () => Promise.resolve([]),
	close: () => Promise.resolve(),
	on: () => {},
	run: () => Promise.resolve(),
	removeWaiting: () => 0,
	removeWaitingJobs: () => [],
	clearWaiting: () => 0,
});

const createInMemoryQueue = (): DeploymentQueue => {
	const queue = new InMemoryQueue({
		resolveConcurrency: resolveBuildsConcurrency,
	});
	queue.process(processDeploymentJob);

	return {
		add: (data, jobId) => queue.add(data, jobId),
		getJobs: (states) => queue.getJobs(states),
		close: () => queue.close(),
		on: () => {},
		run: () => queue.run(),
		removeWaiting: (predicate) => queue.removeWaiting(predicate),
		removeWaitingJobs: (predicate) => queue.removeWaitingJobs(predicate),
		clearWaiting: () => queue.clearWaiting(),
	};
};

// Use a global singleton so the deployment queue is shared across every module
// instance. In dev (tsx/Next) the same file can be evaluated more than once
// (relative import in server.ts vs `@/` alias in the routers); without this the
// worker and the `add()` calls would land on different queue instances.
const globalForQueue = globalThis as unknown as {
	__dokployDeploymentQueue?: DeploymentQueue;
};

if (!globalForQueue.__dokployDeploymentQueue) {
	globalForQueue.__dokployDeploymentQueue = !IS_CLOUD
		? createInMemoryQueue()
		: createNoopQueue();
}

const myQueue: DeploymentQueue = globalForQueue.__dokployDeploymentQueue;

/** Start processing jobs. Called once on server startup (self-hosted). */
export const startDeploymentWorker = () => myQueue.run();

export const getJobsByApplicationId = async (applicationId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter(
		(job) => (job.data as any)?.applicationId === applicationId,
	);
};

export const getJobsByComposeId = async (composeId: string) => {
	const jobs = await myQueue.getJobs();
	return jobs.filter((job) => (job.data as any)?.composeId === composeId);
};

if (!IS_CLOUD) {
	process.on("SIGTERM", () => {
		myQueue.close();
		process.exit(0);
	});
}

export const cleanQueuesByApplication = async (applicationId: string) => {
	const removedJobs = myQueue.removeWaitingJobs(
		(data) => (data as any)?.applicationId === applicationId,
	);
	const deploymentIds = removedJobs.flatMap((job) =>
		job.applicationType === "application" && job.deploymentId
			? [job.deploymentId]
			: [],
	);
	await Promise.all(
		deploymentIds.map((deploymentId) =>
			updateDeploymentStatus(deploymentId, "cancelled"),
		),
	);
	if (removedJobs.length > 0) {
		console.log(
			`Removed ${removedJobs.length} waiting job(s) for application ${applicationId}`,
		);
	}
};


export const cleanQueuesByCompose = async (composeId: string) => {
	const removed = myQueue.removeWaiting(
		(data) => (data as any)?.composeId === composeId,
	);
	if (removed > 0) {
		console.log(`Removed ${removed} waiting job(s) for compose ${composeId}`);
	}
};

export const cleanAllDeploymentQueue = async () => {
	myQueue.clearWaiting();
	return true;
};

export const killDockerBuild = async (
	type: "application" | "compose",
	serverId: string | null,
) => {
	try {
		if (type === "application") {
			const command = `pkill -2 -f "docker build"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		} else if (type === "compose") {
			const command = `pkill -2 -f "docker compose"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		console.error(error);
	}
};

export { myQueue };
