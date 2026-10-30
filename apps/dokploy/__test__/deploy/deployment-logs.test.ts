import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	findDeploymentById: vi.fn(),
	findVolumeBackupById: vi.fn(),
	permission: vi.fn(),
}));

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
	findDeploymentById: mocks.findDeploymentById,
	findVolumeBackupById: mocks.findVolumeBackupById,
}));
vi.mock("@dokploy/server/services/permission", () => ({
	checkServicePermissionAndAccess: mocks.permission,
}));
vi.mock("@/server/api/utils/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/queues/queueSetup", () => ({ myQueue: {} }));
vi.mock("@/server/utils/deploy", () => ({ fetchDeployApiJobs: vi.fn() }));

const { deploymentRouter } = await import("@/server/api/routers/deployment");
const caller = () =>
	deploymentRouter.createCaller({
		session: { activeOrganizationId: "organization-id" },
		user: { id: "user-id", role: "owner", email: "user@example.com" },
	} as never);

describe("deployment volume-backup logs", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.findDeploymentById.mockResolvedValue({
			deploymentId: "deployment-id",
			volumeBackupId: "backup-id",
			logPath: "/etc/dokploy/volume-backups/service/run.log",
		});
		mocks.execAsync.mockResolvedValue({ stdout: "\n" });
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "Upload to S3 done ✅\n",
		});
	});

	it.each(["compose", "application"])(
		"reads the remote %s backup log through its owning service",
		async (serviceType) => {
			mocks.findVolumeBackupById.mockResolvedValue({
				serviceType,
				[`${serviceType}Id`]: "service-id",
				[serviceType]: { serverId: "remote-server" },
			});
			await expect(
				caller().readLogs({ deploymentId: "deployment-id", tail: 10000 }),
			).resolves.toBe("Upload to S3 done ✅\n");
			expect(mocks.permission).toHaveBeenCalledWith(
				expect.anything(),
				"service-id",
				{ deployment: ["read"] },
			);
			expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
				"remote-server",
				expect.stringContaining("tail -n 10000"),
			);
			expect(mocks.execAsync).not.toHaveBeenCalled();
		},
	);

	it("refuses a backup whose owning service is inaccessible before reading a log", async () => {
		mocks.findVolumeBackupById.mockResolvedValue({
			serviceType: "compose",
			composeId: "other-service",
			compose: { serverId: "other-server" },
		});
		mocks.permission.mockRejectedValue(new Error("Service access denied"));
		await expect(
			caller().readLogs({ deploymentId: "deployment-id" }),
		).rejects.toThrow("Service access denied");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("keeps local backup logs on the control plane", async () => {
		mocks.findVolumeBackupById.mockResolvedValue({
			serviceType: "compose",
			composeId: "local-service",
			compose: { serverId: null },
		});
		mocks.execAsync.mockResolvedValue({
			stdout: "Local backup file cleaned up ✅\n",
		});
		await expect(
			caller().readLogs({ deploymentId: "deployment-id" }),
		).resolves.toBe("Local backup file cleaned up ✅\n");
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});
});
