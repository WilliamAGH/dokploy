import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	commit: vi.fn(),
	findApplication: vi.fn(),
	reconcile: vi.fn(),
	returning: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const update = {
		set: vi.fn(),
		where: vi.fn(),
		returning: mocks.returning,
	};
	update.set.mockReturnValue(update);
	update.where.mockReturnValue(update);
	const transactionDb = {
		query: { applications: { findFirst: mocks.findApplication } },
		update: vi.fn(() => update),
	};
	mocks.transaction.mockImplementation(
		async (callback: (tx: typeof transactionDb) => unknown) => {
			const result = await callback(transactionDb);
			await mocks.commit();
			return result;
		},
	);
	return {
		db: {
			query: transactionDb.query,
			transaction: mocks.transaction,
			update: transactionDb.update,
		},
	};
});

vi.mock("@dokploy/server/utils/traefik/domain", () => ({
	reconcileSwarmVipConnectionReuse: mocks.reconcile,
}));

const { updateApplication } = await import(
	"@dokploy/server/services/application"
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.commit.mockReset();
	mocks.commit.mockResolvedValue(undefined);
	mocks.returning.mockResolvedValue([{ applicationId: "application-id" }]);
});

test("reconciles application and preview routes when connection reuse changes", async () => {
	const application = {
		applicationId: "application-id",
		appName: "application",
		serverId: null,
		swarmVipConnectionReuse: true,
		previewDeployments: [{ appName: "preview-one" }],
	};
	mocks.findApplication.mockResolvedValue(application);

	await updateApplication("application-id", {
		swarmVipConnectionReuse: false,
	});

	expect(mocks.reconcile.mock.calls).toEqual([
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "preview-one",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
	]);
});

test("restores routes when committing the setting update fails", async () => {
	const commitError = new Error("commit failed");
	mocks.findApplication.mockResolvedValue({
		applicationId: "application-id",
		appName: "application",
		serverId: null,
		swarmVipConnectionReuse: true,
		previewDeployments: [],
	});
	mocks.commit.mockRejectedValueOnce(commitError);

	await expect(
		updateApplication("application-id", {
			swarmVipConnectionReuse: false,
		}),
	).rejects.toBe(commitError);

	expect(mocks.reconcile.mock.calls).toEqual([
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: true,
			},
		],
	]);
	expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.commit.mock.invocationCallOrder[0] ?? 0,
	);
	expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.reconcile.mock.invocationCallOrder[1] ?? 0,
	);
});

test("keeps routes at the committed setting when commit acknowledgement is lost", async () => {
	const commitError = new Error("commit acknowledgement lost");
	const applicationBeforeUpdate = {
		applicationId: "application-id",
		appName: "application",
		serverId: null,
		swarmVipConnectionReuse: true,
		previewDeployments: [{ appName: "preview-one" }],
	};
	const committedApplication = {
		...applicationBeforeUpdate,
		swarmVipConnectionReuse: false,
	};
	mocks.findApplication
		.mockResolvedValueOnce(applicationBeforeUpdate)
		.mockResolvedValueOnce(committedApplication);
	mocks.commit.mockRejectedValueOnce(commitError);

	await expect(
		updateApplication("application-id", {
			swarmVipConnectionReuse: false,
		}),
	).rejects.toBe(commitError);

	expect(mocks.reconcile.mock.calls).toEqual([
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "preview-one",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "preview-one",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
	]);
	expect(mocks.commit.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.findApplication.mock.invocationCallOrder[1] ?? 0,
	);
});

test("does not reconcile routes for unrelated updates", async () => {
	await updateApplication("application-id", { name: "renamed" });

	expect(mocks.transaction).not.toHaveBeenCalled();
	expect(mocks.findApplication).not.toHaveBeenCalled();
	expect(mocks.reconcile).not.toHaveBeenCalled();
});

test("rolls back the setting update when route reconciliation fails", async () => {
	const reconcileError = new Error("remote write failed");
	mocks.findApplication.mockResolvedValue({
		applicationId: "application-id",
		appName: "application",
		serverId: null,
		swarmVipConnectionReuse: true,
		previewDeployments: [],
	});
	mocks.reconcile.mockRejectedValueOnce(reconcileError);

	await expect(
		updateApplication("application-id", {
			swarmVipConnectionReuse: false,
		}),
	).rejects.toBe(reconcileError);

	expect(mocks.transaction).toHaveBeenCalledOnce();
});

test("restores earlier routes when a later preview reconciliation fails", async () => {
	const reconcileError = new Error("preview write failed");
	mocks.findApplication.mockResolvedValue({
		applicationId: "application-id",
		appName: "application",
		serverId: null,
		swarmVipConnectionReuse: true,
		previewDeployments: [{ appName: "preview-one" }],
	});
	mocks.reconcile
		.mockResolvedValueOnce(undefined)
		.mockRejectedValueOnce(reconcileError)
		.mockResolvedValueOnce(undefined);

	await expect(
		updateApplication("application-id", {
			swarmVipConnectionReuse: false,
		}),
	).rejects.toBe(reconcileError);

	expect(mocks.reconcile.mock.calls).toEqual([
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "preview-one",
				serverId: null,
				swarmVipConnectionReuse: false,
			},
		],
		[
			{
				appName: "application",
				serverId: null,
				swarmVipConnectionReuse: true,
			},
		],
		[
			{
				appName: "preview-one",
				serverId: null,
				swarmVipConnectionReuse: true,
			},
		],
	]);
});
