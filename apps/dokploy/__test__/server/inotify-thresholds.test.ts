import type { InotifyUsage } from "@dokploy/server/services/inotify";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	findOwner: vi.fn(),
	findServers: vi.fn(),
	getInotifyUsage: vi.fn(),
	getWebServerSettings: vi.fn(),
	scheduleJob: vi.fn(),
	scheduledJobs: {} as Record<string, unknown>,
	sendServerThresholdNotifications: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			server: {
				findMany: mocks.findServers,
			},
		},
	},
}));

vi.mock("@dokploy/server/services/admin", () => ({
	findOwner: mocks.findOwner,
}));

vi.mock("@dokploy/server/services/inotify", () => ({
	getInotifyUsage: mocks.getInotifyUsage,
}));

vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));

vi.mock("@dokploy/server/utils/notifications/server-threshold", () => ({
	sendServerThresholdNotifications: mocks.sendServerThresholdNotifications,
}));

vi.mock("node-schedule", () => ({
	scheduleJob: mocks.scheduleJob,
	scheduledJobs: mocks.scheduledJobs,
}));

const usage = (overrides: Partial<InotifyUsage> = {}): InotifyUsage => ({
	defaultUid: 0,
	maxInstances: 10,
	maxQueuedEvents: 16_384,
	maxWatches: 524_288,
	persisted: null,
	users: [],
	...overrides,
});

const loadThresholds = async () => {
	vi.resetModules();
	return import("@dokploy/server/utils/notifications/inotify");
};

// Transforming this module's import graph costs seconds on a cold cache, and
// whichever test imported it first paid that out of its own timeout. Pay it once
// here instead: vi.resetModules() re-executes the module but keeps the transform.
beforeAll(async () => {
	await import("@dokploy/server/utils/notifications/inotify");
}, 60_000);

beforeEach(() => {
	vi.clearAllMocks();
	for (const name of Object.keys(mocks.scheduledJobs)) {
		delete mocks.scheduledJobs[name];
	}
	mocks.findOwner.mockResolvedValue({ organizationId: "owner-org" });
	mocks.findServers.mockResolvedValue([]);
	mocks.getInotifyUsage.mockResolvedValue(usage());
	mocks.getWebServerSettings.mockResolvedValue({
		metricsConfig: { server: { organizationId: "local-org" } },
	});
	mocks.scheduleJob.mockImplementation((name: string) => {
		mocks.scheduledJobs[name] = {};
	});
	mocks.sendServerThresholdNotifications.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("inotify threshold notifications", () => {
	it("registers the scheduler once", async () => {
		const { initInotifyThresholds } = await loadThresholds();

		initInotifyThresholds();
		initInotifyThresholds();

		expect(mocks.scheduleJob).toHaveBeenCalledExactlyOnceWith(
			"inotify-thresholds",
			"* * * * *",
			expect.any(Function),
		);
	});

	it("sends exact-boundary local and remote alerts to their organizations", async () => {
		mocks.findServers.mockResolvedValue([
			{
				serverId: "remote-server",
				organizationId: "remote-org",
				name: "Remote server",
			},
		]);
		mocks.getInotifyUsage.mockImplementation((serverId?: string) =>
			Promise.resolve(
				usage({
					users: [
						{
							uid: serverId ? 2000 : 1000,
							username: null,
							currentInstances: 10,
							descriptorReferences: 10,
						},
						{
							uid: serverId ? 2001 : 1001,
							username: null,
							currentInstances: 9,
							descriptorReferences: 9,
						},
					],
				}),
			),
		);
		const { checkInotifyThresholds } = await loadThresholds();

		await checkInotifyThresholds();

		expect(mocks.getInotifyUsage).toHaveBeenCalledWith("remote-server");
		expect(mocks.getInotifyUsage).toHaveBeenCalledWith(undefined);
		expect(mocks.sendServerThresholdNotifications).toHaveBeenCalledTimes(2);
		expect(mocks.sendServerThresholdNotifications).toHaveBeenCalledWith(
			"remote-org",
			expect.objectContaining({
				ServerName: "Remote server",
				Threshold: 100,
				Type: "Inotify",
				Value: 100,
			}),
		);
		expect(mocks.sendServerThresholdNotifications).toHaveBeenCalledWith(
			"local-org",
			expect.objectContaining({
				ServerName: "Dokploy",
				Threshold: 100,
				Type: "Inotify",
				Value: 100,
			}),
		);
		expect(mocks.findOwner).not.toHaveBeenCalled();
	});

	it("uses the owner fallback for an unenrolled local monitor", async () => {
		mocks.getWebServerSettings.mockResolvedValue({
			metricsConfig: { server: {} },
		});
		mocks.getInotifyUsage.mockResolvedValue(
			usage({
				users: [
					{
						uid: 1000,
						username: null,
						currentInstances: 10,
						descriptorReferences: 12,
					},
				],
			}),
		);
		const { checkInotifyThresholds } = await loadThresholds();

		await checkInotifyThresholds();

		expect(mocks.findOwner).toHaveBeenCalledExactlyOnceWith();
		expect(
			mocks.sendServerThresholdNotifications,
		).toHaveBeenCalledExactlyOnceWith(
			"owner-org",
			expect.objectContaining({ ServerName: "Dokploy", Type: "Inotify" }),
		);
	});

	it("suppresses repeats during cooldown and sends again after recovery", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
		let currentInstances = 10;
		mocks.getInotifyUsage.mockImplementation(() =>
			Promise.resolve(
				usage({
					users: [
						{
							uid: 1000,
							username: null,
							currentInstances,
							descriptorReferences: currentInstances,
						},
					],
				}),
			),
		);
		const { checkInotifyThresholds } = await loadThresholds();

		await checkInotifyThresholds();
		vi.advanceTimersByTime(60_000);
		await checkInotifyThresholds();
		expect(mocks.sendServerThresholdNotifications).toHaveBeenCalledTimes(1);

		currentInstances = 9;
		await checkInotifyThresholds();
		currentInstances = 10;
		await checkInotifyThresholds();

		expect(mocks.sendServerThresholdNotifications).toHaveBeenCalledTimes(2);
	});

	it("skips delivery when a collector cannot provide a valid sample", async () => {
		mocks.getInotifyUsage.mockResolvedValue(
			usage({ error: "host scan unavailable", maxInstances: 0 }),
		);
		const { checkInotifyThresholds } = await loadThresholds();

		await checkInotifyThresholds();

		expect(mocks.sendServerThresholdNotifications).not.toHaveBeenCalled();
	});
});
