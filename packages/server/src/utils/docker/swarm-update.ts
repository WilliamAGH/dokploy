import type Dockerode from "dockerode";
import type { CreateServiceOptions } from "dockerode";
import { sleep } from "../process/execAsync";
import {
	type ExpectedSwarmOperation,
	getDeploymentId,
	getDockerRequestSignal,
	getExpectedTasks,
	getLatestTaskFailure,
	getNextOperationGeneration,
	getSwarmActiveNodeCount,
	getSwarmServiceDesiredTasks,
	getTaskFailure,
	isFailedSwarmTask,
	type SwarmServiceInfo,
	serviceMatchesOperation,
} from "./swarm-state";
import {
	getSwarmServiceUpdateTimeoutMs,
	MIN_SWARM_UPDATE_TIMEOUT_MS,
} from "./swarm-update-timeout";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
type WaitForSwarmServiceUpdateOptions = {
	expectedForceUpdate: number;
	expectedOperationId?: string;
	expectedTaskCount?: number;
	isJob?: boolean;
	keyTasksByNode?: boolean;
	pollIntervalMs?: number;
	previousVersion: number;
	resolveExpectedTaskCount?: () => Promise<number>;
	sleepFn?: (milliseconds: number) => Promise<unknown>;
	timeoutMs: number;
	nowFn?: () => number;
};

const failedUpdateStates = new Set([
	"paused",
	"rollback_paused",
	"rollback_completed",
]);

const inspectService = (
	service: Dockerode.Service,
	timeoutMs = MIN_SWARM_UPDATE_TIMEOUT_MS,
) =>
	service.inspect({
		abortSignal: getDockerRequestSignal(timeoutMs),
	});

export const waitForSwarmServiceUpdate = async (
	docker: Dockerode,
	service: Dockerode.Service,
	options: WaitForSwarmServiceUpdateOptions,
) => {
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const sleepFn = options.sleepFn ?? sleep;
	const nowFn = options.nowFn ?? Date.now;
	const expectedOperation: ExpectedSwarmOperation = {
		forceUpdate: options.expectedForceUpdate,
		id: options.expectedOperationId,
	};
	const expectedTaskState = options.isJob ? "complete" : "running";
	const startedAt = nowFn();
	let lastState = "pending";
	let operationStartedAt: string | undefined;

	while (nowFn() - startedAt < options.timeoutMs) {
		const remainingTimeoutMs = options.timeoutMs - (nowFn() - startedAt);
		const inspect = (await inspectService(
			service,
			remainingTimeoutMs,
		)) as SwarmServiceInfo;
		const version = inspect.Version?.Index ?? 0;

		if (version > options.previousVersion) {
			const state = inspect.UpdateStatus?.State;
			lastState = state ?? "pending";
			const currentOperationStartedAt = inspect.UpdateStatus?.StartedAt;

			let rollbackFailure: string | undefined;
			if (!operationStartedAt) {
				const isExpectedUpdate = serviceMatchesOperation(
					inspect,
					expectedOperation,
				);
				if (state?.startsWith("rollback_")) {
					rollbackFailure = await getLatestTaskFailure(
						docker,
						service.id,
						expectedOperation,
						remainingTimeoutMs,
					);
				}
				const isExpectedRollback = Boolean(rollbackFailure);

				if (!isExpectedUpdate && !isExpectedRollback) {
					throw new Error(
						"Swarm service update was superseded by another operation",
					);
				}

				operationStartedAt = currentOperationStartedAt;
			} else if (
				currentOperationStartedAt &&
				currentOperationStartedAt !== operationStartedAt
			) {
				throw new Error(
					"Swarm service update was superseded by another operation",
				);
			}

			if (state && failedUpdateStates.has(state)) {
				rollbackFailure ??= await getLatestTaskFailure(
					docker,
					service.id,
					expectedOperation,
					remainingTimeoutMs,
				);
				const summary =
					state === "rollback_completed"
						? "Swarm service update rolled back"
						: state === "rollback_paused"
							? "Swarm service rollback paused"
							: "Swarm service update paused";
				const message = inspect.UpdateStatus?.Message;
				throw new Error(
					`${summary}${message ? `: ${message}` : ""}${
						rollbackFailure ? `. Latest task failure: ${rollbackFailure}` : ""
					}`,
				);
			}
			if (
				state === "completed" ||
				(!state && serviceMatchesOperation(inspect, expectedOperation))
			) {
				const { hasActivePredecessor, tasks } = await getExpectedTasks(
					docker,
					service.id,
					expectedOperation,
					remainingTimeoutMs,
					true,
					options.keyTasksByNode,
				);
				const failedTask = tasks.find(isFailedSwarmTask);
				if (failedTask) {
					throw new Error(
						`Swarm service task failed: ${getTaskFailure(failedTask)}`,
					);
				}
				const expectedTaskCount =
					options.expectedTaskCount ??
					(await options.resolveExpectedTaskCount?.());
				if (
					expectedTaskCount !== undefined &&
					!hasActivePredecessor &&
					tasks.length === expectedTaskCount &&
					tasks.every((task) => task.Status?.State === expectedTaskState)
				)
					return;
			}
		}

		await sleepFn(
			Math.min(
				pollIntervalMs,
				Math.max(0, options.timeoutMs - (nowFn() - startedAt)),
			),
		);
	}

	throw new Error(
		`Swarm service update did not finish within ${Math.round(options.timeoutMs / 1_000)} seconds (last state: ${lastState})`,
	);
};

const waitForExpectedSwarmOperation = async (
	docker: Dockerode,
	service: Dockerode.Service,
	settings: CreateServiceOptions,
	inspect: SwarmServiceInfo,
	operation: ExpectedSwarmOperation,
	previousVersion: number,
) => {
	const inspectVersion = Number(inspect.Version?.Index ?? 0);
	const stableSpec =
		previousVersion === inspectVersion
			? inspect.Spec
			: (inspect.PreviousSpec ?? inspect.Spec);
	const configuredTaskCount =
		settings.Mode?.ReplicatedJob?.TotalCompletions ??
		settings.Mode?.Replicated?.Replicas;
	const isReplicatedJob = Boolean(settings.Mode?.ReplicatedJob);
	const isGlobalJob = Boolean(settings.Mode?.GlobalJob);
	const isJob = isReplicatedJob || isGlobalJob;
	await waitForSwarmServiceUpdate(docker, service, {
		expectedForceUpdate: operation.forceUpdate,
		expectedOperationId: operation.id,
		expectedTaskCount: configuredTaskCount,
		isJob,
		keyTasksByNode: Boolean(settings.Mode?.Global || settings.Mode?.GlobalJob),
		previousVersion,
		resolveExpectedTaskCount:
			configuredTaskCount === undefined
				? () =>
						getSwarmServiceDesiredTasks(
							docker,
							service.id,
							isReplicatedJob
								? "replicated-job"
								: isGlobalJob
									? "global-job"
									: "service",
						)
				: undefined,
		timeoutMs: getSwarmServiceUpdateTimeoutMs({
			isJob,
			replicas: configuredTaskCount ?? (await getSwarmActiveNodeCount(docker)),
			rollbackConfig: stableSpec?.RollbackConfig ?? settings.RollbackConfig,
			rollbackTaskTemplate: stableSpec?.TaskTemplate,
			taskTemplate: settings.TaskTemplate,
			updateConfig: settings.UpdateConfig,
		}),
	});
};

const hasStatusCode = (error: unknown, statusCode: number) =>
	typeof error === "object" &&
	error !== null &&
	"statusCode" in error &&
	error.statusCode === statusCode;

const getServiceOperation = (inspect: SwarmServiceInfo, id?: string) => ({
	forceUpdate: Number(inspect.Spec?.TaskTemplate?.ForceUpdate ?? 0),
	id,
});

const getPreviousVersion = (inspect: SwarmServiceInfo) =>
	Math.max(0, Number(inspect.Version?.Index ?? 0) - 1);

export const updateSwarmService = async (
	docker: Dockerode,
	serviceName: string,
	settings: CreateServiceOptions,
): Promise<void> => {
	const service = docker.getService(serviceName);
	let inspect: SwarmServiceInfo;
	try {
		inspect = (await inspectService(service)) as SwarmServiceInfo;
	} catch (error) {
		if (!hasStatusCode(error, 404)) throw error;
		const expectedOperation = {
			forceUpdate: Number(settings.TaskTemplate?.ForceUpdate ?? 0),
			id: getDeploymentId(settings.TaskTemplate),
		};
		try {
			const createSettings = {
				...settings,
				abortSignal: getDockerRequestSignal(),
			};
			await (settings.authconfig
				? docker.createService(settings.authconfig, createSettings)
				: docker.createService(createSettings));
		} catch (createError) {
			try {
				inspect = (await inspectService(service)) as SwarmServiceInfo;
			} catch {
				throw createError;
			}
			if (!serviceMatchesOperation(inspect, expectedOperation)) {
				throw createError;
			}
		}
		inspect ??= (await inspectService(service)) as SwarmServiceInfo;
		await waitForExpectedSwarmOperation(
			docker,
			service,
			settings,
			inspect,
			expectedOperation,
			getPreviousVersion(inspect),
		);
		return;
	}

	const operationId = getDeploymentId(settings.TaskTemplate);
	const currentOperation = getServiceOperation(inspect, operationId);
	if (
		operationId &&
		getDeploymentId(inspect.Spec?.TaskTemplate) === operationId
	) {
		const taskFailure = await getLatestTaskFailure(
			docker,
			service.id,
			currentOperation,
			MIN_SWARM_UPDATE_TIMEOUT_MS,
			true,
		);
		if (!taskFailure) {
			await waitForExpectedSwarmOperation(
				docker,
				service,
				settings,
				inspect,
				currentOperation,
				getPreviousVersion(inspect),
			);
			return;
		}
	}

	const previousVersion = Number(inspect.Version?.Index ?? 0);
	const expectedOperation: ExpectedSwarmOperation = {
		forceUpdate: await getNextOperationGeneration(
			docker,
			service.id,
			operationId,
			currentOperation.forceUpdate,
		),
		id: operationId,
	};
	try {
		await service.update({
			abortSignal: getDockerRequestSignal(),
			version: previousVersion,
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: expectedOperation.forceUpdate,
			},
		});
	} catch (error) {
		let current: SwarmServiceInfo;
		try {
			current = (await inspectService(service)) as SwarmServiceInfo;
		} catch {
			throw error;
		}
		if (serviceMatchesOperation(current, expectedOperation)) {
			await waitForExpectedSwarmOperation(
				docker,
				service,
				settings,
				current,
				expectedOperation,
				getPreviousVersion(current),
			);
			return;
		}
		throw error;
	}

	await waitForExpectedSwarmOperation(
		docker,
		service,
		settings,
		inspect,
		expectedOperation,
		previousVersion,
	);
};

export { DEPLOYMENT_ID_LABEL } from "./swarm-state";
export { getSwarmServiceUpdateTimeoutMs } from "./swarm-update-timeout";
