import {
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	rollback,
	updateApplicationStatus,
	updateCompose,
	updateDeployment,
	updateDeploymentStatus,
	updatePreviewDeployment,
} from "@dokploy/server";
import type { DeployJob } from "./schema.js";

export const deploy = async (job: DeployJob) => {
	try {
		if (job.applicationType === "application") {
			await updateApplicationStatus(job.applicationId, "running");
			if (job.type === "rollback") {
				await updateDeployment(job.deploymentId, {
					status: "running",
					finishedAt: null,
					errorMessage: null,
				});
				await rollback(job.rollbackId);
				await updateDeploymentStatus(job.deploymentId, "done");
				await updateApplicationStatus(job.applicationId, "done");
			} else if (job.server) {
				if (job.type === "redeploy") {
					await rebuildApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Rebuild deployment",
						descriptionLog: job.descriptionLog || "",
					});
				} else if (job.type === "deploy") {
					await deployApplication({
						applicationId: job.applicationId,
						deploymentId: job.deploymentId,
						expectedDockerImage: job.expectedDockerImage,
						expectedLabelsSwarm: job.expectedLabelsSwarm,
						titleLog: job.titleLog || "Manual deployment",
						descriptionLog: job.descriptionLog || "",
						sourceRevision: job.sourceRevision,
					});
				}
			}
		} else if (job.applicationType === "compose") {
			await updateCompose(job.composeId, {
				composeStatus: "running",
			});

			if (job.server) {
				if (job.type === "redeploy") {
					await rebuildCompose({
						composeId: job.composeId,
						titleLog: job.titleLog || "Rebuild deployment",
						descriptionLog: job.descriptionLog || "",
					});
				} else if (job.type === "deploy") {
					await deployCompose({
						composeId: job.composeId,
						titleLog: job.titleLog || "Manual deployment",
						descriptionLog: job.descriptionLog || "",
					});
				}
			}
		} else if (job.applicationType === "application-preview") {
			await updatePreviewDeployment(job.previewDeploymentId, {
				previewStatus: "running",
			});
			if (job.server) {
				if (job.type === "redeploy") {
					await rebuildPreviewApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Rebuild Preview Deployment",
						descriptionLog: job.descriptionLog || "",
						previewDeploymentId: job.previewDeploymentId,
					});
				} else if (job.type === "deploy") {
					await deployPreviewApplication({
						applicationId: job.applicationId,
						titleLog: job.titleLog || "Preview Deployment",
						descriptionLog: job.descriptionLog || "",
						previewDeploymentId: job.previewDeploymentId,
					});
				}
			}
		}
	} catch (e) {
		if (job.applicationType === "application") {
			if (job.type === "rollback") {
				await updateDeployment(job.deploymentId, {
					status: "error",
					finishedAt: new Date().toISOString(),
					errorMessage: e instanceof Error ? e.message : String(e),
				});
			}
			await updateApplicationStatus(job.applicationId, "error");
		} else if (job.applicationType === "compose") {
			await updateCompose(job.composeId, {
				composeStatus: "error",
			});
		} else if (job.applicationType === "application-preview") {
			await updatePreviewDeployment(job.previewDeploymentId, {
				previewStatus: "error",
			});
		}

		throw e;
	}

	return true;
};
