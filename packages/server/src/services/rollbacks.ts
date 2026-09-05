import type { CreateServiceOptions } from "dockerode";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createRollbackSchema,
	deployments as deploymentsSchema,
	rollbacks,
} from "../db/schema";
import { decryptValue, encryptValue } from "../lib/encryption";
import type { ApplicationNested } from "../utils/builders";
import { getAuthConfig } from "../utils/builders/auth";
import { getRegistryTag, isImmutableImage } from "../utils/cluster/upload";
import {
	DEPLOYMENT_ID_LABEL,
	updateSwarmService,
} from "../utils/docker/swarm-update";
import {
	calculateResources,
	generateBindMounts,
	generateConfigContainer,
	generateFileMounts,
	generateVolumeMounts,
	prepareEnvironmentVariables,
} from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import {
	sourceRevisionLabelPlaceholder,
	sourceRevisionSchema,
} from "../utils/providers/git";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { withResolvedVaultRefs } from "../utils/vault";
import { findApplicationById } from "./application";
import { findDeploymentById } from "./deployment";
import { getImageConfig } from "./docker-image";
import { resolveServiceNetworks } from "./network";
import {
	findRegistryByIdWithCredentials,
	type Registry,
	safeDockerLoginCommand,
} from "./registry";

type RawRollbackApplicationSnapshot = ApplicationNested & {
	bitbucket?: unknown;
	github?: unknown;
	gitlab?: unknown;
	gitea?: unknown;
};

type RollbackApplicationSnapshot = Omit<
	RawRollbackApplicationSnapshot,
	"buildRegistry" | "registry" | "rollbackRegistry"
> & {
	buildRegistry?: Registry | null;
	registry?: Registry | null;
	rollbackRegistry?: Registry | null;
	sourceRevision?: string;
};

type EncryptedRollbackContext = { encrypted: string };

const encryptRollbackContext = (
	context: RollbackApplicationSnapshot,
): EncryptedRollbackContext => ({
	encrypted: encryptValue(JSON.stringify(context)),
});

const readRollbackContext = (
	context: unknown,
): RollbackApplicationSnapshot | null => {
	if (!context) return null;
	if (
		typeof context === "object" &&
		"encrypted" in context &&
		typeof context.encrypted === "string"
	) {
		return JSON.parse(
			decryptValue(context.encrypted),
		) as RollbackApplicationSnapshot;
	}
	return context as RollbackApplicationSnapshot;
};

export const createRollback = async (
	input: Omit<z.infer<typeof createRollbackSchema>, "fullContext"> & {
		fullContext?: ApplicationNested;
		rollbackSource?: {
			authConfig?: {
				password: string;
				serveraddress: string;
				username: string;
			};
			image: string;
			labels: Record<string, string>;
		};
	},
) => {
	return await db.transaction(async (tx) => {
		const { fullContext, rollbackSource, ...other } = input;
		const rollback = await tx
			.insert(rollbacks)
			.values(other)
			.returning()
			.then((res) => res[0]);

		if (!rollback) {
			throw new Error("Failed to create rollback");
		}

		const tagImage = `${input.appName}:v${rollback.version}`;
		const deployment = await findDeploymentById(rollback.deploymentId);

		if (!deployment?.applicationId) {
			throw new Error("Deployment not found");
		}

		const rollbackContext: RawRollbackApplicationSnapshot =
			fullContext ?? (await findApplicationById(deployment.applicationId));
		const {
			deployments: _,
			bitbucket,
			github,
			gitlab,
			gitea,
			...rest
		} = rollbackContext;

		const registry = rest.registryId
			? await findRegistryByIdWithCredentials(rest.registryId)
			: rest.registry;
		const buildRegistry = rest.buildRegistryId
			? await findRegistryByIdWithCredentials(rest.buildRegistryId)
			: rest.buildRegistry;
		const rollbackRegistry = rest.rollbackRegistryId
			? await findRegistryByIdWithCredentials(rest.rollbackRegistryId)
			: rest.rollbackRegistry;
		const sourceRevisionLabel = Object.entries(rest.labelsSwarm ?? {}).find(
			([, value]) => value === sourceRevisionLabelPlaceholder,
		)?.[0];
		const sourceRevision = sourceRevisionLabel
			? sourceRevisionSchema.parse(
					rollbackSource?.labels[sourceRevisionLabel] ??
						(
							await getImageConfig(
								`${input.appName}:latest`,
								rest.buildServerId || rest.serverId || undefined,
							)
						).Config?.Labels?.["org.opencontainers.image.revision"],
				)
			: undefined;

		const fullContextWithCredentials = {
			...rest,
			registry,
			buildRegistry,
			rollbackRegistry,
			sourceRevision,
			...(rest.sourceType === "docker" &&
				rollbackSource && {
					buildRegistry: null,
					buildRegistryId: null,
					dockerImage: rollbackSource.image,
					labelsSwarm: rollbackSource.labels,
					password: rollbackSource.authConfig?.password ?? null,
					registry: null,
					registryId: null,
					registryUrl: rollbackSource.authConfig?.serveraddress ?? null,
					username: rollbackSource.authConfig?.username ?? null,
				}),
		};

		const [updatedRollback] = await tx
			.update(rollbacks)
			.set({
				image: tagImage,
				fullContext: encryptRollbackContext(
					fullContextWithCredentials as unknown as RollbackApplicationSnapshot,
				),
			})
			.where(eq(rollbacks.rollbackId, rollback.rollbackId))
			.returning();
		if (!updatedRollback) {
			throw new Error("Failed to create rollback");
		}

		return updatedRollback;
	});
};

export const findRollbackById = async (rollbackId: string) => {
	const result = await db.query.rollbacks.findFirst({
		where: eq(rollbacks.rollbackId, rollbackId),
		with: {
			deployment: {
				with: {
					application: {
						columns: { applicationId: true, appName: true, serverId: true },
					},
				},
			},
		},
	});

	if (!result) {
		throw new Error("Rollback not found");
	}

	return result;
};

export const createRollbackDeploymentSubmission = async (
	rollbackId: string,
	applicationId: string,
) => {
	const deploymentId = `rollback-${rollbackId}`;
	const [deployment] = await db
		.insert(deploymentsSchema)
		.values({
			deploymentId,
			applicationId,
			title: "Rollback deployment",
			description: "",
			status: "running",
			logPath: "",
			startedAt: new Date().toISOString(),
		})
		.onConflictDoNothing()
		.returning();

	let current = deployment ?? (await findDeploymentById(deploymentId));
	let claimed = false;
	const reclaimableStatus = ["error", "cancelled"] as const;
	if (
		!deployment &&
		reclaimableStatus.includes(
			current.status as (typeof reclaimableStatus)[number],
		)
	) {
		const [retry] = await db
			.update(deploymentsSchema)
			.set({
				status: "running",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				errorMessage: null,
			})
			.where(
				and(
					eq(deploymentsSchema.deploymentId, deploymentId),
					inArray(deploymentsSchema.status, reclaimableStatus),
				),
			)
			.returning();
		claimed = Boolean(retry);
		current = retry ?? (await findDeploymentById(deploymentId));
	}

	return {
		deployment: current,
		shouldDispatch:
			Boolean(deployment) ||
			claimed ||
			(current.status === "running" && !current.logPath),
	};
};

export const discardRollback = async (
	rollbackId: string,
	deploymentId: string,
) => {
	await db.transaction(async (tx) => {
		await tx
			.update(deploymentsSchema)
			.set({ rollbackId: null })
			.where(eq(deploymentsSchema.deploymentId, deploymentId));
		await tx.delete(rollbacks).where(eq(rollbacks.rollbackId, rollbackId));
	});
};

export const confirmRollback = async (
	rollbackId: string,
	deploymentId: string,
) => {
	await db
		.update(deploymentsSchema)
		.set({ rollbackId })
		.where(eq(deploymentsSchema.deploymentId, deploymentId));
};

const deleteRollbackImage = async (image: string, serverId?: string | null) => {
	const command = `docker image rm ${image} --force`;

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const removeRollbackById = async (rollbackId: string) => {
	const rollback = await findRollbackById(rollbackId);

	if (rollback?.image) {
		const fullContext = readRollbackContext(rollback.fullContext);
		if (!fullContext?.rollbackRegistryId) {
			try {
				const application = rollback.deployment.application;
				if (!application) {
					throw new Error("Deployment not found");
				}
				await deleteRollbackImage(rollback.image, application.serverId);
			} catch (error) {
				console.error(error);
			}
		}
		await db.delete(rollbacks).where(eq(rollbacks.rollbackId, rollbackId));
	}

	return rollback;
};

export const rollback = async (rollbackId: string) => {
	const result = await findRollbackById(rollbackId);
	const application = result.deployment.application;
	if (!application) {
		throw new Error("Deployment not found");
	}

	const fullContext = readRollbackContext(result.fullContext);
	if (!fullContext) {
		throw new Error("Rollback context not found");
	}
	if (
		fullContext.appName !== application.appName ||
		(fullContext.serverId ?? null) !== (application.serverId ?? null)
	) {
		throw new Error("Rollback target has changed since the image was captured");
	}
	const immutableDockerBaseline =
		fullContext.sourceType === "docker" &&
		isImmutableImage(fullContext.dockerImage || "")
			? fullContext.dockerImage
			: undefined;
	await rollbackApplication(
		fullContext.appName,
		immutableDockerBaseline || result.image || "",
		result.rollbackId,
		fullContext.serverId,
		fullContext,
	);
};

const rollbackApplication = async (
	appName: string,
	image: string,
	rollbackId: string,
	serverId?: string | null,
	fullContext?: RollbackApplicationSnapshot,
) => {
	if (!fullContext) {
		throw new Error("Full context is required for rollback");
	}

	const resolvedContext = await withResolvedVaultRefs(fullContext);

	const rollbackRegistry = resolvedContext.rollbackRegistry ?? undefined;
	const usesRollbackAlias = Boolean(
		rollbackRegistry && !isImmutableImage(image),
	);
	const authConfig = usesRollbackAlias
		? {
				password: rollbackRegistry!.password,
				username: rollbackRegistry!.username,
				serveraddress: rollbackRegistry!.registryUrl,
			}
		: await getAuthConfig(resolvedContext as ApplicationNested);

	if (authConfig) {
		const loginCommand = safeDockerLoginCommand(
			authConfig.serveraddress,
			authConfig.username,
			authConfig.password,
		);
		try {
			if (serverId) {
				await execAsyncRemote(serverId, loginCommand);
			} else {
				await execAsync(loginCommand);
			}
		} catch {
			throw new Error("Registry authentication failed");
		}
	}

	const docker = await getRemoteDocker(serverId);

	const {
		env,
		mounts,
		cpuLimit,
		memoryLimit,
		memoryReservation,
		cpuReservation,
		command,
		args,
		ports,
	} = resolvedContext;

	const resources = calculateResources({
		memoryLimit,
		memoryReservation,
		cpuLimit,
		cpuReservation,
	});

	const volumesMount = generateVolumeMounts(mounts);

	const resolvedNetworks = await resolveServiceNetworks(
		resolvedContext as Parameters<typeof resolveServiceNetworks>[0],
	);

	const {
		HealthCheck,
		RestartPolicy,
		Placement,
		Labels,
		Mode,
		RollbackConfig,
		UpdateConfig,
		StopGracePeriod,
		EndpointSpec,
		Ulimits,
	} = generateConfigContainer(
		resolvedContext as Parameters<typeof generateConfigContainer>[0],
		resolvedContext.sourceRevision,
	);

	const bindsMount = generateBindMounts(mounts);
	const filesMount = generateFileMounts(
		appName,
		resolvedContext as Parameters<typeof generateFileMounts>[1],
	);
	const envVariables = prepareEnvironmentVariables(
		env,
		resolvedContext.environment.project.env,
		resolvedContext.environment.env,
	);

	const rollbackImage = usesRollbackAlias
		? getRegistryTag(rollbackRegistry!, image)
		: image;

	const settings: CreateServiceOptions = {
		authconfig: authConfig,
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				HealthCheck,
				Image: rollbackImage,
				Env: envVariables,
				Mounts: [...volumesMount, ...bindsMount, ...filesMount],
				...(StopGracePeriod !== null &&
					StopGracePeriod !== undefined && { StopGracePeriod }),
				...(command && { Command: command.split(" ") }),
				...(args && args.length > 0 && { Args: args }),
				...(Ulimits && { Ulimits }),
				Labels: {
					...Labels,
					[DEPLOYMENT_ID_LABEL]: `rollback-${rollbackId}`,
				},
			},
			Networks: resolvedNetworks,
			RestartPolicy,
			Placement,
			Resources: {
				...resources,
			},
		},
		Mode,
		RollbackConfig,
		EndpointSpec: EndpointSpec ?? {
			Ports: ports.map((port) => ({
				PublishMode: port.publishMode,
				Protocol: port.protocol,
				TargetPort: port.targetPort,
				PublishedPort: port.publishedPort,
			})),
		},
		UpdateConfig,
	};

	await updateSwarmService(docker, appName, settings);
};
