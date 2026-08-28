import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import {
	deployApplication,
	deployPreviewApplication,
	rebuildApplication,
	rebuildPreviewApplication,
} from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as githubService from "@dokploy/server/services/github";
import * as previewDeploymentService from "@dokploy/server/services/preview-deployment";
import * as builders from "@dokploy/server/utils/builders";
import * as notifications from "@dokploy/server/utils/notifications/build-success";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => {
	const createChainableMock = (): any => {
		const chain = {
			set: vi.fn(() => chain),
			where: vi.fn(() => chain),
			returning: vi.fn().mockResolvedValue([{}] as any),
			from: vi.fn(() => chain),
			innerJoin: vi.fn(() => chain),
			then: (resolve: (v: any) => void) => {
				resolve([]);
			},
		} as any;
		return chain;
	};

	return {
		db: {
			select: vi.fn(() => createChainableMock()),
			insert: vi.fn(),
			update: vi.fn(() => createChainableMock()),
			delete: vi.fn(),
			query: {
				applications: {
					findFirst: vi.fn(),
				},
				patch: {
					findMany: vi.fn().mockResolvedValue([]),
				},
				member: {
					findMany: vi.fn().mockResolvedValue([]),
				},
			},
		},
	};
});

vi.mock("@dokploy/server/services/application", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/application")
	>("@dokploy/server/services/application");
	return {
		...actual,
		findApplicationById: vi.fn(),
		updateApplicationStatus: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: vi.fn(),
}));

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	createDeploymentPreview: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/services/github", () => ({
	createPreviewDeploymentComment: vi.fn(),
	getIssueComment: vi.fn(() => "preview deployment comment"),
	issueCommentExists: vi.fn(),
	updateIssueComment: vi.fn(),
}));

vi.mock("@dokploy/server/services/preview-deployment", () => ({
	findPreviewDeploymentById: vi.fn(),
	updatePreviewDeployment: vi.fn(),
}));

vi.mock("@dokploy/server/utils/providers/git", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/providers/git")
	>("@dokploy/server/utils/providers/git");
	return {
		...actual,
		getGitCommitInfo: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	ExecError: class ExecError extends Error {},
}));

vi.mock("@dokploy/server/utils/builders", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/builders")
	>("@dokploy/server/utils/builders");
	return {
		...actual,
		mechanizeDockerContainer: vi.fn(),
		getBuildCommand: vi.fn(),
	};
});

vi.mock("@dokploy/server/utils/notifications/build-success", () => ({
	sendBuildSuccessNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/utils/notifications/build-error", () => ({
	sendBuildErrorNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/services/rollbacks", () => ({
	createRollback: vi.fn(),
}));

import { db } from "@dokploy/server/db";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import * as githubProvider from "@dokploy/server/utils/providers/github";

const sourceRevision = "0123456789abcdef0123456789abcdef01234567";

const createMockApplication = (overrides = {}) => ({
	applicationId: "test-app-id",
	name: "Test App",
	appName: "test-app",
	sourceType: "git" as const,
	customGitUrl: "https://github.com/Dokploy/examples.git",
	customGitBranch: "main",
	customGitSSHKeyId: null,
	buildType: "nixpacks" as const,
	buildPath: "/astro",
	env: "NODE_ENV=production",
	serverId: null,
	rollbackActive: false,
	enableSubmodules: false,
	environmentId: "env-id",
	environment: {
		projectId: "project-id",
		env: "",
		name: "production",
		project: {
			name: "Test Project",
			organizationId: "org-id",
			env: "",
		},
	},
	domains: [],
	...overrides,
});

const createMockDeployment = () => ({
	deploymentId: "deployment-id",
	logPath: "/tmp/test-deployment.log",
});

const createMockPreviewDeployment = () => ({
	appName: "preview-test-app",
	branch: "feature/preview",
	domain: {
		host: "preview.example.com",
		https: true,
	},
	pullRequestCommentId: "123",
	pullRequestNumber: "42",
});

describe("deployApplication - Command Generation Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			createMockApplication() as any,
		);
		vi.mocked(adminService.getDokployUrl).mockResolvedValue(
			"http://localhost:3000",
		);
		vi.mocked(deploymentService.createDeployment).mockResolvedValue(
			createMockDeployment() as any,
		);
		vi.mocked(deploymentService.createDeploymentPreview).mockResolvedValue(
			createMockDeployment() as any,
		);
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		} as any);
		vi.mocked(builders.mechanizeDockerContainer).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(deploymentService.updateDeploymentStatus).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(applicationService.updateApplicationStatus).mockResolvedValue(
			{} as any,
		);
		vi.mocked(notifications.sendBuildSuccessNotifications).mockResolvedValue(
			undefined as any,
		);
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValue({
			message: "test commit",
			hash: sourceRevision,
		});
		vi.mocked(githubProvider.cloneGithubRepository).mockResolvedValue(
			"git clone github",
		);
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
		vi.mocked(githubService.issueCommentExists).mockResolvedValue(true);
		vi.mocked(githubService.updateIssueComment).mockResolvedValue(undefined);
		vi.mocked(
			previewDeploymentService.findPreviewDeploymentById,
		).mockResolvedValue(createMockPreviewDeployment() as any);
		vi.mocked(
			previewDeploymentService.updatePreviewDeployment,
		).mockResolvedValue({} as any);
	});

	it("should generate correct git clone command for astro example", async () => {
		const app = createMockApplication();
		const command = await cloneGitRepository(app);
		console.log(command);

		expect(command).toContain("https://github.com/Dokploy/examples.git");
		expect(command).not.toContain("--recurse-submodules");
		expect(command).toContain("--branch main");
		expect(command).toContain("--depth 1");
		expect(command).toContain("git clone");
	});

	it("should generate git clone with submodules when enabled", async () => {
		const app = createMockApplication({ enableSubmodules: true });
		const command = await cloneGitRepository(app);

		expect(command).toContain("--recurse-submodules");
		expect(command).toContain("https://github.com/Dokploy/examples.git");
	});

	it("should verify nixpacks command is called with correct app", async () => {
		const mockNixpacksCommand = "nixpacks build /path/to/app --name test-app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test deployment",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "nixpacks",
				customGitUrl: "https://github.com/Dokploy/examples.git",
				buildPath: "/astro",
			}),
			sourceRevision,
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("nixpacks build"),
		);
	});

	it("should verify railpack command includes correct parameters", async () => {
		const mockApp = createMockApplication({ buildType: "railpack" });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			mockApp as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			mockApp as any,
		);

		const mockRailpackCommand = "railpack prepare /path/to/app";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockRailpackCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Railpack test",
			descriptionLog: "",
		});

		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				buildType: "railpack",
			}),
			sourceRevision,
		);

		expect(execProcess.execAsync).toHaveBeenCalledWith(
			expect.stringContaining("railpack prepare"),
		);
	});

	it("should execute commands in correct order", async () => {
		const mockNixpacksCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockNixpacksCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		expect(execCalls.length).toBeGreaterThan(0);

		const cloneCommand = execCalls[0]?.[0];
		const buildCommand = execCalls[1]?.[0];
		expect(cloneCommand).toContain("set -e");
		expect(cloneCommand).toContain("git clone");
		expect(buildCommand).toContain("nixpacks build");
	});

	it("should include log redirection in command", async () => {
		const mockCommand = "nixpacks build";
		vi.mocked(builders.getBuildCommand).mockResolvedValue(mockCommand);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Test",
			descriptionLog: "",
		});

		const execCalls = vi.mocked(execProcess.execAsync).mock.calls;
		const fullCommand = execCalls[1]?.[0];

		expect(fullCommand).toContain(">> /tmp/test-deployment.log 2>&1");
	});

	it("pins a GitHub webhook deployment to its source revision", async () => {
		const githubApplication = createMockApplication({ sourceType: "github" });
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			githubApplication as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			githubApplication as any,
		);

		await deployApplication({
			applicationId: "test-app-id",
			titleLog: "Webhook deployment",
			descriptionLog: "",
			sourceRevision,
		});

		expect(githubProvider.cloneGithubRepository).toHaveBeenCalledWith(
			expect.objectContaining({ sourceRevision }),
		);
		expect(gitProvider.getGitCommitInfo).toHaveBeenCalledWith(
			expect.objectContaining({ expectedRevision: sourceRevision }),
		);
		expect(builders.mechanizeDockerContainer).toHaveBeenCalledWith(
			expect.anything(),
			sourceRevision,
		);
	});

	it.each([
		["blank", ""],
		["short", "0123456789abcdef"],
		["uppercase", "0123456789ABCDEF0123456789ABCDEF01234567"],
		["non-hex", "gggggggggggggggggggggggggggggggggggggggg"],
	])(
		"rejects a $0 GitHub webhook revision before cloning, building, or rendering",
		async (_revisionType, invalidSourceRevision) => {
			const githubApplication = createMockApplication({ sourceType: "github" });
			vi.mocked(db.query.applications.findFirst).mockResolvedValue(
				githubApplication as any,
			);
			vi.mocked(applicationService.findApplicationById).mockResolvedValue(
				githubApplication as any,
			);

			await expect(
				deployApplication({
					applicationId: "test-app-id",
					descriptionLog: "",
					sourceRevision: invalidSourceRevision,
					titleLog: "Webhook deployment",
				}),
			).rejects.toThrow("Source revision must be a lowercase 40-hex SHA");

			expect(githubProvider.cloneGithubRepository).not.toHaveBeenCalled();
			expect(builders.getBuildCommand).not.toHaveBeenCalled();
			expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
		},
	);

	it("fails before rendering when the checkout revision is unavailable", async () => {
		vi.mocked(gitProvider.getGitCommitInfo).mockResolvedValueOnce(null);

		await expect(
			deployApplication({
				applicationId: "test-app-id",
				titleLog: "Test",
				descriptionLog: "",
			}),
		).rejects.toThrow("Unable to determine a valid checkout source revision");

		expect(builders.getBuildCommand).not.toHaveBeenCalled();
		expect(builders.mechanizeDockerContainer).not.toHaveBeenCalled();
	});

	it("derives the current checkout revision before rebuilding", async () => {
		await rebuildApplication({
			applicationId: "test-app-id",
			titleLog: "Rebuild",
			descriptionLog: "",
		});

		expect(gitProvider.getGitCommitInfo).toHaveBeenCalledWith(
			expect.objectContaining({
				appName: "test-app",
				type: "application",
			}),
		);
		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.anything(),
			sourceRevision,
		);
		expect(builders.mechanizeDockerContainer).toHaveBeenCalledWith(
			expect.anything(),
			sourceRevision,
		);
	});

	it("derives the preview checkout revision before building and rendering", async () => {
		const githubApplication = createMockApplication({
			githubId: "github-id",
			owner: "dokploy",
			previewBuildArgs: "",
			previewBuildSecrets: "",
			previewEnv: "",
			repository: "dokploy",
			sourceType: "github",
		});
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			githubApplication as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			githubApplication as any,
		);
		vi.mocked(builders.getBuildCommand).mockResolvedValue("preview build");

		await deployPreviewApplication({
			applicationId: "test-app-id",
			descriptionLog: "",
			previewDeploymentId: "preview-deployment-id",
			titleLog: "Preview",
		});

		expect(gitProvider.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "preview-test-app",
			serverId: null,
			type: "application",
		});
		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "preview-test-app" }),
			sourceRevision,
		);
		expect(builders.mechanizeDockerContainer).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "preview-test-app" }),
			sourceRevision,
		);
	});

	it("derives the existing preview checkout revision before rebuilding", async () => {
		const githubApplication = createMockApplication({
			githubId: "github-id",
			owner: "dokploy",
			previewBuildArgs: "",
			previewBuildSecrets: "",
			previewEnv: "",
			repository: "dokploy",
			sourceType: "github",
		});
		vi.mocked(db.query.applications.findFirst).mockResolvedValue(
			githubApplication as any,
		);
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			githubApplication as any,
		);
		vi.mocked(builders.getBuildCommand).mockResolvedValue("preview build");

		await rebuildPreviewApplication({
			applicationId: "test-app-id",
			descriptionLog: "",
			previewDeploymentId: "preview-deployment-id",
			titleLog: "Preview rebuild",
		});

		expect(gitProvider.getGitCommitInfo).toHaveBeenCalledWith({
			appName: "preview-test-app",
			serverId: null,
			type: "application",
		});
		expect(builders.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "preview-test-app" }),
			sourceRevision,
		);
		expect(builders.mechanizeDockerContainer).toHaveBeenCalledWith(
			expect.objectContaining({ appName: "preview-test-app" }),
			sourceRevision,
		);
	});
});
