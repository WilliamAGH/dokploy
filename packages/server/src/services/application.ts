import { docker } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateApplication,
	applications,
	buildAppName,
} from "@dokploy/server/db/schema";
import { getAdvancedStats } from "@dokploy/server/monitoring/utils";
import { readTraefikRuntimeConfig } from "@dokploy/server/setup/traefik-setup";
import {
	getBuildCommand,
	mechanizeDockerContainer,
} from "@dokploy/server/utils/builders";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";
import {
	cloneGitRepository,
	getGitCommitInfo,
	sourceRevisionSchema,
} from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { createTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { TRPCError } from "@trpc/server";
import type { MountSettings, NetworkAttachmentConfig } from "dockerode";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getDokployUrl } from "./admin";
import {
	createDeployment,
	createDeploymentPreview,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { type Domain, getDomainHost } from "./domain";
import {
	createPreviewDeploymentComment,
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import { generateApplyPatchesCommand } from "./patch";
import {
	findPreviewDeploymentById,
	updatePreviewDeployment,
} from "./preview-deployment";
import { validUniqueServerAppName } from "./project";
export type Application = typeof applications.$inferSelect;

const runtimeTaskLabelKeys = new Set([
	"org.opencontainers.image.revision",
	"otel.deployment.environment.name",
	"otel.logs.enabled",
	"otel.service.name",
	"otel.service.version",
]);

type RuntimeTaskNetworkAttachment = {
	Addresses?: string[];
	Network?: { Spec?: { Name?: string } };
};

const runtimeRouterLabelSuffixes = [
	".entrypoints",
	".middlewares",
	".rule",
	".service",
	".tls",
	".tls.certresolver",
];
const runtimeServiceLabelSuffixes = [
	".loadbalancer.server.port",
	".loadbalancer.healthcheck.path",
	".loadbalancer.healthcheck.interval",
	".loadbalancer.healthcheck.unhealthyinterval",
	".loadbalancer.healthcheck.timeout",
	".loadbalancer.healthcheck.status",
	".loadbalancer.healthcheck.initialstatus",
];

const runtimeRootLabels = (
	appName: string,
	labels: Record<string, string> | undefined,
) =>
	Object.fromEntries(
		Object.entries(labels ?? {}).filter(
			([key]) =>
				key === "traefik.enable" ||
				key === "traefik.swarm.network" ||
				key === "traefik.swarm.lbswarm" ||
				(key.startsWith(`traefik.http.routers.${appName}-`) &&
					runtimeRouterLabelSuffixes.some((suffix) => key.endsWith(suffix))) ||
				(key.startsWith(`traefik.http.services.${appName}-`) &&
					runtimeServiceLabelSuffixes.some((suffix) => key.endsWith(suffix))) ||
				(key.startsWith(`traefik.http.middlewares.stripprefix-${appName}-`) &&
					key.endsWith(".stripprefix.prefixes")) ||
				(key.startsWith(`traefik.http.middlewares.addprefix-${appName}-`) &&
					key.endsWith(".addprefix.prefix")),
		),
	);

const runtimeTaskLabels = (labels: Record<string, string> | undefined) =>
	Object.fromEntries(
		Object.entries(labels ?? {}).filter(([key]) =>
			runtimeTaskLabelKeys.has(key),
		),
	);

const runtimeLocalHealthCheckTest = (test: string[] | undefined) => {
	if (
		test?.length !== 4 ||
		test[0] !== "CMD" ||
		test[1] !== "curl" ||
		test[2] !== "-f"
	) {
		return null;
	}
	try {
		const target = new URL(test[3] ?? "");
		if (
			target.protocol !== "http:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
			target.username ||
			target.password ||
			target.search ||
			target.hash
		) {
			return null;
		}
		return test;
	} catch {
		return null;
	}
};

const labelOwnerIds = (
	labels: Record<string, string>,
	prefix: string,
	suffix: string,
) =>
	Object.keys(labels)
		.filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
		.map((key) => key.slice(prefix.length, -suffix.length));

const sanitizedServerStatus = (
	serverStatus: Record<string, string> | undefined,
) =>
	Object.fromEntries(
		Object.entries(serverStatus ?? {}).flatMap(([server, status]) => {
			try {
				return [[new URL(server).origin, status]];
			} catch {
				return [];
			}
		}),
	);

const runtimeTraefikRouting = async (
	serverId: string | null,
	appName: string,
	rootLabels: Record<string, string>,
) => {
	const swarmRouterIds = labelOwnerIds(
		rootLabels,
		"traefik.http.routers.",
		".rule",
	).map((routerId) => `${routerId}@swarm`);
	const swarmServiceIds = labelOwnerIds(
		rootLabels,
		"traefik.http.services.",
		".loadbalancer.server.port",
	).map((serviceId) => `${serviceId}@swarm`);
	const runtime = await readTraefikRuntimeConfig(serverId ?? undefined);
	const fileRouterIds = Object.keys(runtime.routers ?? {}).filter(
		(routerId) =>
			routerId.startsWith(`${appName}-router-`) && routerId.endsWith("@file"),
	);
	const fileServiceIds = Object.keys(runtime.services ?? {}).filter(
		(serviceId) =>
			serviceId.startsWith(`${appName}-service-`) &&
			serviceId.endsWith("@file"),
	);
	return {
		routers: [...swarmRouterIds, ...fileRouterIds].flatMap((routerId) => {
			const router = runtime.routers?.[routerId];
			return router
				? [{ routerId, status: router.status, service: router.service }]
				: [];
		}),
		services: [...swarmServiceIds, ...fileServiceIds].flatMap((serviceId) => {
			const service = runtime.services?.[serviceId];
			return service
				? [
						{
							serviceId,
							status: service.status,
							serverStatus: sanitizedServerStatus(service.serverStatus),
						},
					]
				: [];
		}),
	};
};

export const createApplication = async (
	input: z.infer<typeof apiCreateApplication>,
) => {
	const appName = buildAppName("app", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application with this 'AppName' already exists",
		});
	}

	return await db.transaction(async (tx) => {
		const newApplication = await tx
			.insert(applications)
			.values({
				...input,
				appName,
			})
			.returning()
			.then((value) => value[0]);

		if (!newApplication) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the application",
			});
		}

		if (process.env.NODE_ENV === "development") {
			createTraefikConfig(newApplication.appName);
		}

		return newApplication;
	});
};

export const findApplicationById = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: { with: { project: true } },
			domains: true,
			deployments: true,
			mounts: true,
			redirects: true,
			security: true,
			ports: true,
			gitlab: {
				columns: { secret: false, accessToken: false, refreshToken: false },
			},
			github: {
				columns: {
					githubClientSecret: false,
					githubPrivateKey: false,
					githubWebhookSecret: false,
				},
			},
			bitbucket: { columns: { appPassword: false, apiToken: false } },
			gitea: {
				columns: {
					clientSecret: false,
					accessToken: false,
					refreshToken: false,
				},
			},
			server: true,
			previewDeployments: true,
			registry: { columns: { password: false } },
			buildRegistry: { columns: { password: false } },
			rollbackRegistry: { columns: { password: false } },
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	return application;
};

export const findApplicationRuntimeServiceState = async (
	applicationId: string,
	organizationId: string,
) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		columns: {
			applicationId: true,
			appName: true,
			name: true,
			serverId: true,
		},
		with: {
			environment: {
				columns: {},
				with: {
					project: { columns: { organizationId: true } },
				},
			},
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	if (application.environment.project.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this application",
		});
	}

	const dockerClient = await getRemoteDocker(application.serverId);
	const service = await dockerClient.getService(application.appName).inspect();
	if (!service.Spec) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application service not found",
		});
	}

	const task = service.Spec.TaskTemplate;
	const container =
		task && "ContainerSpec" in task ? task.ContainerSpec : undefined;
	const health = container?.HealthCheck;
	const restart = task?.RestartPolicy;
	const placement = task?.Placement;
	const update = service.Spec.UpdateConfig;
	const rollback = service.Spec.RollbackConfig;
	const mode = service.Spec.Mode;
	const rootLabels = runtimeRootLabels(
		application.appName,
		service.Spec.Labels,
	);
	const traefik = await runtimeTraefikRouting(
		application.serverId,
		application.appName,
		rootLabels,
	);
	const tasks = await dockerClient.listTasks({
		filters: JSON.stringify({ service: [application.appName] }),
	});

	return {
		application: {
			applicationId: application.applicationId,
			appName: application.appName,
			name: application.name,
			serverId: application.serverId,
		},
		service: {
			serviceId: service.ID,
			versionIndex: service.Version?.Index ?? null,
			name: service.Spec.Name ?? application.appName,
			rootLabels,
			taskLabels: runtimeTaskLabels(container?.Labels),
			image: container?.Image ?? null,
			replicas: mode?.Replicated?.Replicas ?? null,
			mode: mode
				? {
						Replicated: mode.Replicated
							? { Replicas: mode.Replicated.Replicas }
							: undefined,
						Global: mode.Global ? {} : undefined,
						ReplicatedJob: mode.ReplicatedJob
							? {
									MaxConcurrent: mode.ReplicatedJob.MaxConcurrent,
									TotalCompletions: mode.ReplicatedJob.TotalCompletions,
								}
							: undefined,
						GlobalJob: mode.GlobalJob ? {} : undefined,
					}
				: null,
			healthCheck: health
				? {
						Test: runtimeLocalHealthCheckTest(health.Test),
						Interval: health.Interval,
						Timeout: health.Timeout,
						StartPeriod: health.StartPeriod,
						Retries: health.Retries,
					}
				: null,
			restartPolicy: restart
				? {
						Condition: restart.Condition,
						Delay: restart.Delay,
						MaxAttempts: restart.MaxAttempts,
						Window: restart.Window,
					}
				: null,
			placement: placement
				? {
						Constraints: placement.Constraints,
						Preferences: placement.Preferences,
						MaxReplicas: placement.MaxReplicas,
						Platforms: placement.Platforms,
					}
				: null,
			updateConfig: update
				? {
						Parallelism: update.Parallelism,
						Delay: update.Delay,
						FailureAction: update.FailureAction,
						Monitor: update.Monitor,
						MaxFailureRatio: update.MaxFailureRatio,
						Order: update.Order,
					}
				: null,
			rollbackConfig: rollback
				? {
						Parallelism: rollback.Parallelism,
						Delay: rollback.Delay,
						FailureAction: rollback.FailureAction,
						Monitor: rollback.Monitor,
						MaxFailureRatio: rollback.MaxFailureRatio,
						Order: rollback.Order,
					}
				: null,
			updateStatus: service.UpdateStatus
				? {
						State: service.UpdateStatus.State,
						StartedAt: service.UpdateStatus.StartedAt,
						CompletedAt: service.UpdateStatus.CompletedAt,
					}
				: null,
			serviceStatus: service.ServiceStatus
				? {
						RunningTasks: service.ServiceStatus.RunningTasks,
						DesiredTasks: service.ServiceStatus.DesiredTasks,
						CompletedTasks: service.ServiceStatus.CompletedTasks,
					}
				: null,
			stopGracePeriod: container?.StopGracePeriod ?? null,
			networks: (task?.Networks ?? []).map(
				(network: NetworkAttachmentConfig) => ({
					Target: network.Target,
					Aliases: network.Aliases,
				}),
			),
			volumeMounts: (container?.Mounts ?? [])
				.filter((mount: MountSettings) => mount.Type === "volume")
				.map((mount: MountSettings) => ({
					Type: mount.Type,
					Source: mount.Source,
					Target: mount.Target,
					ReadOnly: mount.ReadOnly,
				})),
		},
		tasks: tasks
			.filter(
				(serviceTask) =>
					serviceTask.DesiredState === "running" ||
					serviceTask.Status?.State === "running",
			)
			.map((serviceTask) => ({
				taskId: serviceTask.ID,
				slot: serviceTask.Slot,
				nodeId: serviceTask.NodeID,
				desiredState: serviceTask.DesiredState,
				status: serviceTask.Status
					? {
							state: serviceTask.Status.State,
							timestamp: serviceTask.Status.Timestamp,
							containerId: serviceTask.Status.ContainerStatus?.ContainerID,
						}
					: null,
				addresses: (serviceTask.NetworksAttachments ?? [])
					.filter(
						(attachment: RuntimeTaskNetworkAttachment) =>
							attachment.Network?.Spec?.Name === "dokploy-network",
					)
					.flatMap(
						(attachment: RuntimeTaskNetworkAttachment) =>
							attachment.Addresses ?? [],
					),
			})),
		traefik,
	};
};

export const findApplicationByName = async (appName: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
	});

	return application;
};

export const updateApplication = async (
	applicationId: string,
	applicationData: Partial<Application>,
) => {
	const { appName, ...rest } = applicationData;
	const application = await db
		.update(applications)
		.set({
			...rest,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application[0];
};

export const updateApplicationStatus = async (
	applicationId: string,
	applicationStatus: Application["applicationStatus"],
) => {
	const application = await db
		.update(applications)
		.set({
			applicationStatus: applicationStatus,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application;
};

export const deployApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
	sourceRevision,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	sourceRevision?: string;
}) => {
	const application = await findApplicationById(applicationId);
	const serverId = application.buildServerId || application.serverId;
	const applicationEntity = {
		...application,
		serverId: serverId,
	};

	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});
	const isGitSource =
		application.sourceType !== "docker" && application.sourceType !== "drop";
	let commitInfo: Awaited<ReturnType<typeof getGitCommitInfo>> = null;

	try {
		if (sourceRevision !== undefined && application.sourceType !== "github") {
			throw new Error("Only GitHub deployments can specify a source revision");
		}
		const expectedSourceRevision = sourceRevisionSchema
			.optional()
			.parse(sourceRevision);
		let command = "set -e;";
		if (application.sourceType === "github") {
			command += await cloneGithubRepository({
				...applicationEntity,
				sourceRevision: expectedSourceRevision,
			});
		} else if (application.sourceType === "gitlab") {
			command += await cloneGitlabRepository(applicationEntity);
		} else if (application.sourceType === "gitea") {
			command += await cloneGiteaRepository(applicationEntity);
		} else if (application.sourceType === "bitbucket") {
			command += await cloneBitbucketRepository(applicationEntity);
		} else if (application.sourceType === "git") {
			command += await cloneGitRepository(applicationEntity);
		} else if (application.sourceType === "docker") {
			command += await buildRemoteDocker(application);
		}

		if (isGitSource) {
			const cloneCommandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (serverId) {
				await execAsyncRemote(serverId, cloneCommandWithLog);
			} else {
				await execAsync(cloneCommandWithLog);
			}

			commitInfo = await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId,
				expectedRevision: expectedSourceRevision,
			});
			if (!commitInfo) {
				throw new Error("Unable to determine a valid checkout source revision");
			}
			command = "set -e;";
		}

		if (application.sourceType !== "docker") {
			command += await generateApplyPatchesCommand({
				id: application.applicationId,
				type: "application",
				serverId,
			});
		}

		command += await getBuildCommand(application, commitInfo?.hash);

		const commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (serverId) {
			await execAsyncRemote(serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await mechanizeDockerContainer(application, commitInfo?.hash);
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");

		await sendBuildErrorNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			// @ts-expect-error
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: application.environment.project.organizationId,
		});

		throw error;
	} finally {
		if (commitInfo) {
			await updateDeployment(deployment.deploymentId, {
				title: commitInfo.message,
				description: `Commit: ${commitInfo.hash}`,
			});
		}
	}
	return true;
};

export const rebuildApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const application = await findApplicationById(applicationId);
	const serverId = application.buildServerId || application.serverId;
	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;

	const deployment = await createDeployment({
		applicationId: applicationId,
		title: titleLog,
		description: descriptionLog,
	});
	const isGitSource =
		application.sourceType !== "docker" && application.sourceType !== "drop";

	try {
		const commitInfo = isGitSource
			? await getGitCommitInfo({
					appName: application.appName,
					type: "application",
					serverId,
				})
			: null;
		if (isGitSource && !commitInfo) {
			throw new Error("Unable to determine a valid checkout source revision");
		}
		let command = "set -e;";
		command += await getBuildCommand(application, commitInfo?.hash);
		const commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (serverId) {
			await execAsyncRemote(serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		await mechanizeDockerContainer(application, commitInfo?.hash);
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");
		throw error;
	}

	return true;
};

export const deployPreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const application = await findApplicationById(applicationId);

	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeploymentId,
	});

	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.rollbackActive = false;
		application.buildRegistry = null;
		application.rollbackRegistry = null;
		application.registry = null;

		let command = "set -e;";
		if (application.sourceType === "github") {
			command += await cloneGithubRepository({
				...application,
				appName: previewDeployment.appName,
				branch: previewDeployment.branch,
			});
			const commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (application.serverId) {
				await execAsyncRemote(application.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
			const commitInfo = await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId: application.serverId,
			});
			if (!commitInfo) {
				throw new Error("Unable to determine a valid checkout source revision");
			}
			command = "set -e;";
			command += await getBuildCommand(application, commitInfo.hash);
			const buildCommandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (application.serverId) {
				await execAsyncRemote(application.serverId, buildCommandWithLog);
			} else {
				await execAsync(buildCommandWithLog);
			}
			await mechanizeDockerContainer(application, commitInfo.hash);
		}
		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const rebuildPreviewApplication = async ({
	applicationId,
	titleLog = "Rebuild Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
}) => {
	const application = await findApplicationById(applicationId);
	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);

	const deployment = await createDeploymentPreview({
		title: titleLog,
		description: descriptionLog,
		previewDeploymentId: previewDeploymentId,
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}

		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});

		// Set application properties for preview deployment
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.rollbackActive = false;
		application.buildRegistry = null;
		application.rollbackRegistry = null;
		application.registry = null;

		const serverId = application.serverId;
		let command = "set -e;";
		const commitInfo = await getGitCommitInfo({
			appName: application.appName,
			type: "application",
			serverId,
		});
		if (!commitInfo) {
			throw new Error("Unable to determine a valid checkout source revision");
		}
		// Only rebuild, don't clone repository
		command += await getBuildCommand(application, commitInfo.hash);
		const commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (serverId) {
			await execAsyncRemote(serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		await mechanizeDockerContainer(application, commitInfo.hash);

		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		const serverId = application.buildServerId || application.serverId;
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}

		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const getApplicationStats = async (appName: string) => {
	if (appName === "dokploy") {
		return await getAdvancedStats(appName);
	}
	const filter = {
		status: ["running"],
		label: [`com.docker.swarm.service.name=${appName}`],
	};

	const containers = await docker.listContainers({
		filters: JSON.stringify(filter),
	});

	const container = containers[0];
	if (!container || container?.State !== "running") {
		return null;
	}

	const data = await getAdvancedStats(appName);

	return data;
};
