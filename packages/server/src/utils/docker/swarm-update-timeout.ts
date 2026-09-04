import type { CreateServiceOptions } from "dockerode";

const DEFAULT_MONITOR_NS = 30_000_000_000;
const UPDATE_TIMEOUT_BUFFER_MS = 60 * 1_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_NS = 30_000_000_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_NS = 30_000_000_000;
const DEFAULT_HEALTH_CHECK_START_INTERVAL_NS = 5_000_000_000;
const DEFAULT_HEALTH_CHECK_RETRIES = 3;
const DEFAULT_STOP_GRACE_PERIOD_NS = 10_000_000_000;

export const MIN_SWARM_UPDATE_TIMEOUT_MS = 2 * 60 * 1_000;
const JOB_COMPLETION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

type SwarmUpdateConfig = Partial<
	NonNullable<CreateServiceOptions["UpdateConfig"]>
>;

const nanosecondsToMilliseconds = (
	value: number | undefined,
	defaultValue = 0,
) => Math.max(0, value ?? defaultValue) / 1_000_000;

const getHealthCheckAdmissionMs = (
	taskTemplate: CreateServiceOptions["TaskTemplate"] | undefined,
) => {
	if (!taskTemplate || !("ContainerSpec" in taskTemplate)) return 0;
	const healthCheck = taskTemplate.ContainerSpec?.HealthCheck as
		| (NonNullable<
				NonNullable<typeof taskTemplate.ContainerSpec>["HealthCheck"]
		  > & { StartInterval?: number })
		| undefined;
	if (!healthCheck || healthCheck.Test?.[0] === "NONE") return 0;

	const intervalMs = nanosecondsToMilliseconds(
		healthCheck.Interval,
		DEFAULT_HEALTH_CHECK_INTERVAL_NS,
	);
	const timeoutMs = nanosecondsToMilliseconds(
		healthCheck.Timeout,
		DEFAULT_HEALTH_CHECK_TIMEOUT_NS,
	);
	const startPeriodMs = nanosecondsToMilliseconds(healthCheck.StartPeriod);
	const startIntervalMs = nanosecondsToMilliseconds(
		healthCheck.StartInterval,
		DEFAULT_HEALTH_CHECK_START_INTERVAL_NS,
	);
	const retries = Math.max(
		0,
		healthCheck.Retries ?? DEFAULT_HEALTH_CHECK_RETRIES,
	);

	return (
		startPeriodMs +
		timeoutMs +
		startIntervalMs +
		retries * (intervalMs + timeoutMs)
	);
};

const getPhaseTimeoutMs = (
	config: SwarmUpdateConfig | undefined,
	replicas: number,
	taskTemplate: CreateServiceOptions["TaskTemplate"] | undefined,
) => {
	const parallelism = Math.max(0, config?.Parallelism ?? 1);
	const batches =
		parallelism === 0
			? 1
			: Math.max(1, Math.ceil(Math.max(1, replicas) / parallelism));
	const monitorMs = nanosecondsToMilliseconds(
		config?.Monitor,
		DEFAULT_MONITOR_NS,
	);
	const delayMs = nanosecondsToMilliseconds(config?.Delay);
	const stopGracePeriodMs = nanosecondsToMilliseconds(
		taskTemplate && "ContainerSpec" in taskTemplate
			? taskTemplate.ContainerSpec?.StopGracePeriod
			: undefined,
		DEFAULT_STOP_GRACE_PERIOD_NS,
	);
	const startStopWorkMs =
		getHealthCheckAdmissionMs(taskTemplate) + stopGracePeriodMs;

	return (
		batches * startStopWorkMs +
		batches * delayMs +
		Math.max(monitorMs, delayMs + 1_000)
	);
};

export const getSwarmServiceUpdateTimeoutMs = ({
	replicas,
	rollbackConfig,
	rollbackTaskTemplate,
	taskTemplate,
	updateConfig,
	isJob = false,
}: {
	isJob?: boolean;
	replicas: number;
	rollbackConfig?: SwarmUpdateConfig;
	rollbackTaskTemplate?: CreateServiceOptions["TaskTemplate"];
	taskTemplate?: CreateServiceOptions["TaskTemplate"];
	updateConfig?: SwarmUpdateConfig;
}) =>
	Math.max(
		isJob ? JOB_COMPLETION_TIMEOUT_MS : MIN_SWARM_UPDATE_TIMEOUT_MS,
		getPhaseTimeoutMs(updateConfig, replicas, taskTemplate) +
			getPhaseTimeoutMs(
				rollbackConfig,
				replicas,
				rollbackTaskTemplate ?? taskTemplate,
			) +
			UPDATE_TIMEOUT_BUFFER_MS,
	);
