import {
	createRollbackDeploymentSubmission,
	findRollbackById,
	IS_CLOUD,
	removeRollbackById,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { apiFindOneRollback } from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import { createTRPCRouter, protectedProcedure } from "../trpc";

export const rollbackRouter = createTRPCRouter({
	delete: protectedProcedure
		.input(apiFindOneRollback)
		.output(z.object({ rollbackId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			try {
				const rb = await findRollbackById(input.rollbackId);
				const serviceId = rb.deployment.applicationId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						deployment: ["create"],
					});
				}
				await removeRollbackById(input.rollbackId);
				await audit(ctx, {
					action: "delete",
					resourceType: "deployment",
					resourceId: input.rollbackId,
				});
				return { rollbackId: input.rollbackId };
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Error input: Deleting rollback";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	rollback: protectedProcedure
		.input(apiFindOneRollback)
		.output(z.object({ deploymentId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			try {
				const rb = await findRollbackById(input.rollbackId);
				const serviceId = rb.deployment.applicationId;
				if (!serviceId) {
					throw new Error("Rollback deployment application not found");
				}
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["create"],
				});
				const serverId = rb.deployment.application?.serverId ?? undefined;
				if (IS_CLOUD && !serverId) {
					throw new Error("Cloud rollback requires a deployment server");
				}
				const submission = await createRollbackDeploymentSubmission(
					input.rollbackId,
					serviceId,
				);
				if (submission.shouldDispatch) {
					const jobData: DeploymentJob = {
						applicationId: serviceId,
						deploymentId: submission.deployment.deploymentId,
						rollbackId: input.rollbackId,
						titleLog: "Rollback deployment",
						descriptionLog: "",
						type: "rollback",
						applicationType: "application",
						serverId,
					};
					if (IS_CLOUD) {
						await deploy(jobData);
					} else {
						await myQueue.add(jobData, submission.deployment.deploymentId);
					}
				}
				await audit(ctx, {
					action: "restore",
					resourceType: "deployment",
					resourceId: input.rollbackId,
				});
				return { deploymentId: submission.deployment.deploymentId };
			} catch (error) {
				console.error(error);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error input: Rolling back",
					cause: error,
				});
			}
		}),
});
