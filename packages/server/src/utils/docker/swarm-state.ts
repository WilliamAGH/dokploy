import type Dockerode from "dockerode";
import type { CreateServiceOptions } from "dockerode";
import { MIN_SWARM_UPDATE_TIMEOUT_MS } from "./swarm-update-timeout";

const DOCKER_REQUEST_TIMEOUT_MS = 30_000;
export const DEPLOYMENT_ID_LABEL = "dokploy.deployment.id";

export type SwarmServiceInfo = {
	Version?: { Index?: number };
	UpdateStatus?: { State?: string; Message?: string; StartedAt?: string };
	Spec?: Pick<CreateServiceOptions, "RollbackConfig" | "TaskTemplate">;
	PreviousSpec?: SwarmServiceInfo["Spec"];
};
type SwarmServiceStatus = {
	ServiceStatus?: { CompletedTasks?: number; DesiredTasks?: number };
};
export type SwarmTask = {
	DesiredState?: string;
	ID?: string;
	NodeID?: string;
	Slot?: number;
	Version?: { Index?: number };
	Spec?: CreateServiceOptions["TaskTemplate"];
	Status?: {
		State?: string;
		Err?: string;
		Message?: string;
		ContainerStatus?: { ExitCode?: number };
	};
};
export type ExpectedSwarmOperation = { id?: string; forceUpdate: number };

const failedTaskStates = new Set(["failed", "rejected", "orphaned"]);
const retiredTaskStates = new Set(["remove", "shutdown"]);
const terminalTaskStates = new Set([
	"complete",
	"failed",
	"orphaned",
	"rejected",
	"remove",
	"shutdown",
]);

export const getDockerRequestSignal = (timeoutMs = DOCKER_REQUEST_TIMEOUT_MS) =>
	AbortSignal.any([
		AbortSignal.timeout(Math.max(1, timeoutMs)),
		AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MS),
	]);

export const getDeploymentId = (
	taskTemplate: CreateServiceOptions["TaskTemplate"] | undefined,
) =>
	taskTemplate && "ContainerSpec" in taskTemplate
		? taskTemplate.ContainerSpec?.Labels?.[DEPLOYMENT_ID_LABEL]
		: undefined;

const taskMatchesOperation = (
	task: SwarmTask,
	operation: ExpectedSwarmOperation,
) =>
	task.Spec?.ForceUpdate === operation.forceUpdate &&
	getDeploymentId(task.Spec) === operation.id;

export const serviceMatchesOperation = (
	service: SwarmServiceInfo,
	operation: ExpectedSwarmOperation,
) =>
	service.Spec?.TaskTemplate?.ForceUpdate === operation.forceUpdate &&
	getDeploymentId(service.Spec?.TaskTemplate) === operation.id;

export const getTaskFailure = (task: SwarmTask) =>
	[
		task.Status?.Err || task.Status?.Message || task.Status?.State,
		task.Status?.ContainerStatus?.ExitCode !== undefined
			? `exit code ${task.Status.ContainerStatus.ExitCode}`
			: undefined,
	]
		.filter(Boolean)
		.join(", ");

export const isFailedSwarmTask = (task: SwarmTask) =>
	failedTaskStates.has(task.Status?.State ?? "");

export const getExpectedTasks = async (
	docker: Dockerode,
	serviceName: string,
	operation: ExpectedSwarmOperation,
	timeoutMs = MIN_SWARM_UPDATE_TIMEOUT_MS,
	current = false,
	keyByNode = false,
) => {
	const serviceTasks = (await docker.listTasks({
		abortSignal: getDockerRequestSignal(timeoutMs),
		filters: JSON.stringify({ service: [serviceName] }),
	})) as SwarmTask[];
	const matching = serviceTasks.filter((task) =>
		taskMatchesOperation(task, operation),
	);
	if (!current) return { hasActivePredecessor: false, tasks: matching };
	const active = matching.filter(
		(task) => !retiredTaskStates.has(task.DesiredState ?? ""),
	);
	return {
		hasActivePredecessor: serviceTasks.some(
			(task) =>
				!taskMatchesOperation(task, operation) &&
				!terminalTaskStates.has(task.Status?.State ?? ""),
		),
		tasks: [
			...(active.length > 0 ? active : matching)
				.sort(
					(left, right) =>
						(left.Version?.Index ?? 0) - (right.Version?.Index ?? 0),
				)
				.reduce(
					(latest, task) =>
						latest.set(
							String(
								keyByNode ? (task.NodeID ?? task.ID) : (task.Slot ?? task.ID),
							),
							task,
						),
					new Map<string, SwarmTask>(),
				)
				.values(),
		],
	};
};

export const getLatestTaskFailure = async (
	docker: Dockerode,
	serviceName: string,
	operation: ExpectedSwarmOperation,
	timeoutMs = MIN_SWARM_UPDATE_TIMEOUT_MS,
	current = false,
) => {
	const failedTask = (
		await getExpectedTasks(docker, serviceName, operation, timeoutMs, current)
	).tasks
		.filter(isFailedSwarmTask)
		.sort(
			(left, right) => (right.Version?.Index ?? 0) - (left.Version?.Index ?? 0),
		)[0];
	return failedTask && getTaskFailure(failedTask);
};

export const getSwarmServiceDesiredTasks = async (
	docker: Dockerode,
	serviceId: string,
	mode: "service" | "replicated-job" | "global-job",
) => {
	const [service] = (await docker.listServices({
		abortSignal: getDockerRequestSignal(),
		filters: JSON.stringify({ id: [serviceId] }),
		status: true,
	})) as SwarmServiceStatus[];
	const status = service?.ServiceStatus;
	const desiredTasks =
		mode === "replicated-job"
			? status?.CompletedTasks
			: status?.DesiredTasks === undefined
				? undefined
				: status.DesiredTasks +
					(mode === "global-job" ? (status.CompletedTasks ?? 0) : 0);
	if (desiredTasks === undefined) {
		throw new Error("Swarm service desired task count is unavailable");
	}
	return Math.max(0, desiredTasks);
};

export const getSwarmActiveNodeCount = async (docker: Dockerode) => {
	const nodes = (await docker.listNodes({
		abortSignal: getDockerRequestSignal(),
	})) as Array<{
		Spec?: { Availability?: string };
		Status?: { State?: string };
	}>;
	return Math.max(
		1,
		nodes.filter(
			(node) =>
				node.Spec?.Availability === "active" && node.Status?.State === "ready",
		).length,
	);
};

export const getNextOperationGeneration = async (
	docker: Dockerode,
	serviceName: string,
	operationId: string | undefined,
	currentGeneration: number,
) => {
	if (!operationId) return currentGeneration + 1;
	const tasks = (await docker.listTasks({
		abortSignal: getDockerRequestSignal(),
		filters: JSON.stringify({ service: [serviceName] }),
	})) as SwarmTask[];
	return (
		tasks
			.filter((task) => getDeploymentId(task.Spec) === operationId)
			.reduce(
				(latest, task) => Math.max(latest, task.Spec?.ForceUpdate ?? 0),
				currentGeneration,
			) + 1
	);
};
