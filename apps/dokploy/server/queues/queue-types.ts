type ApplicationDeploymentJob = {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	server?: boolean;
	applicationType: "application";
	serverId?: string;
} & (
	| {
			deploymentId?: string;
			expectedDockerImage?: string;
			expectedLabelsSwarm?: Record<string, string>;
			sourceRevision?: string;
			type: "deploy" | "redeploy";
	  }
	| {
			deploymentId: string;
			rollbackId: string;
			type: "rollback";
	  }
);

type DeployJob =
	| ApplicationDeploymentJob
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "compose";
			serverId?: string;
			freshVolumes?: boolean;
	  }
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application-preview";
			previewDeploymentId: string;
			serverId?: string;
	  };

export type DeploymentJob = DeployJob;
