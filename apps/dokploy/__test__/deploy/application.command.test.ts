import * as adminService from "@dokploy/server/services/admin";
import * as applicationService from "@dokploy/server/services/application";
import { deployApplication } from "@dokploy/server/services/application";
import * as deploymentService from "@dokploy/server/services/deployment";
import * as permissionService from "@dokploy/server/services/permission";
import * as builders from "@dokploy/server/utils/builders";
import {
	scaleService,
	scaleServiceRemote,
	startService,
	startServiceRemote,
	stopService,
	stopServiceRemote,
} from "@dokploy/server/utils/docker/utils";
import * as notifications from "@dokploy/server/utils/notifications/build-success";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import * as gitProvider from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applicationRouter } from "@/server/api/routers/application";
import { apiScaleApplication } from "@/server/db/schema";

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
				webServerSettings: {
					findFirst: vi.fn().mockResolvedValue({}),
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
		updateApplication: vi.fn(),
		updateApplicationStatus: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/permission", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/permission")
	>("@dokploy/server/services/permission");
	return {
		...actual,
		checkServicePermissionAndAccess: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/admin", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/services/admin")
	>("@dokploy/server/services/admin");
	return {
		...actual,
		getDokployUrl: vi.fn(),
	};
});

vi.mock("@dokploy/server/services/deployment", () => ({
	createDeployment: vi.fn(),
	updateDeploymentStatus: vi.fn(),
	updateDeployment: vi.fn(),
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

vi.mock("@dokploy/server/utils/process/execAsync", async () => {
	const actual = await vi.importActual<
		typeof import("@dokploy/server/utils/process/execAsync")
	>("@dokploy/server/utils/process/execAsync");
	return {
		...actual,
		execAsync: vi.fn(),
		execAsyncRemote: vi.fn(),
	};
});

vi.mock("@/server/api/utils/audit", () => ({
	audit: vi.fn(),
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
			hash: "abc123",
		});
		vi.mocked(deploymentService.updateDeployment).mockResolvedValue({} as any);
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

		const fullCommand = execCalls[0]?.[0];
		expect(fullCommand).toContain("set -e");
		expect(fullCommand).toContain("git clone");
		expect(fullCommand).toContain("nixpacks build");
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
		const fullCommand = execCalls[0]?.[0];

		expect(fullCommand).toContain(">> /tmp/test-deployment.log 2>&1");
	});
});

describe("application scaling", () => {
	const caller = () =>
		applicationRouter.createCaller({
			session: { activeOrganizationId: "org-id" },
			user: {
				id: "user-id",
				email: "user@example.com",
				role: "owner",
			},
		} as any);
	const givenApplication = (overrides = {}) => {
		const application = createMockApplication({ replicas: 2, ...overrides });
		vi.mocked(applicationService.findApplicationById).mockResolvedValue(
			application as any,
		);
		return application;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "",
			stderr: "",
		});
		vi.mocked(execProcess.execAsyncRemote).mockResolvedValue({
			stdout: "",
			stderr: "",
		});
		vi.mocked(
			permissionService.checkServicePermissionAndAccess,
		).mockResolvedValue(undefined);
		vi.mocked(applicationService.updateApplication).mockResolvedValue(
			{} as any,
		);
	});

	it("accepts only a nonempty application id and positive integer replicas", async () => {
		expect(
			apiScaleApplication.safeParse({
				applicationId: "test-app-id",
				replicas: 3,
			}).success,
		).toBe(true);

		for (const replicas of [0, -1, 1.5]) {
			expect(
				apiScaleApplication.safeParse({
					applicationId: "test-app-id",
					replicas,
				}).success,
			).toBe(false);
		}

		expect(
			apiScaleApplication.safeParse({ applicationId: "", replicas: 1 }).success,
		).toBe(false);
		await expect(
			caller().scale({ applicationId: "test-app-id", replicas: 0 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(
			permissionService.checkServicePermissionAndAccess,
		).not.toHaveBeenCalled();
	});

	it.each([
		{ location: "local", serverId: null, replicas: 3 },
		{ location: "remote", serverId: "server-id", replicas: 4 },
	])(
		"scales the $location service and persists the same replica count",
		async ({ serverId, replicas }) => {
			const application = givenApplication({ serverId });
			const result = { applicationId: application.applicationId, replicas };

			await expect(
				caller().scale({ applicationId: application.applicationId, replicas }),
			).resolves.toEqual(result);

			if (serverId) {
				expect(execProcess.execAsyncRemote).toHaveBeenCalledWith(
					serverId,
					`docker service scale test-app=${replicas} `,
				);
				expect(execProcess.execAsync).not.toHaveBeenCalled();
			} else {
				expect(execProcess.execAsync).toHaveBeenCalledWith(
					`docker service scale test-app=${replicas} `,
				);
				expect(execProcess.execAsyncRemote).not.toHaveBeenCalled();
			}
			expect(applicationService.updateApplication).toHaveBeenCalledWith(
				application.applicationId,
				{ replicas },
			);
		},
	);

	it("restores the prior runtime count when metadata persistence fails", async () => {
		const application = givenApplication({ replicas: 2 });
		vi.mocked(applicationService.updateApplication).mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(
			caller().scale({ applicationId: application.applicationId, replicas: 1 }),
		).rejects.toThrow("database unavailable");
		expect(vi.mocked(execProcess.execAsync).mock.calls).toEqual([
			["docker service scale test-app=1 "],
			["docker service scale test-app=2 "],
		]);
	});

	it("keeps start and stop at one and zero replicas", async () => {
		await scaleService("test-app", 3);
		await scaleServiceRemote("server-id", "test-app", 4);
		await startService("test-app");
		await startServiceRemote("server-id", "test-app");
		await stopService("test-app");
		await stopServiceRemote("server-id", "test-app");

		expect(vi.mocked(execProcess.execAsync).mock.calls).toEqual([
			["docker service scale test-app=3 "],
			["docker service scale test-app=1 "],
			["docker service scale test-app=0 "],
		]);
		expect(vi.mocked(execProcess.execAsyncRemote).mock.calls).toEqual([
			["server-id", "docker service scale test-app=4 "],
			["server-id", "docker service scale test-app=1 "],
			["server-id", "docker service scale test-app=0 "],
		]);
	});
});
