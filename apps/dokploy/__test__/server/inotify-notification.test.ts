import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	settings: vi.fn(),
	send: vi.fn(),
	servers: vi.fn(),
	findOwner: vi.fn(),
	updateSettings: vi.fn(),
	setupMonitoring: vi.fn(),
}));

vi.mock("@dokploy/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@dokploy/server")>()),
	findOwner: mocks.findOwner,
	getWebServerSettings: mocks.settings,
	IS_CLOUD: false,
	sendServerThresholdNotifications: mocks.send,
	setupWebMonitoring: mocks.setupMonitoring,
	updateWebServerSettings: mocks.updateSettings,
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: { webServerSettings: { findFirst: async () => ({}) } },
		select: () => ({
			from: () => ({
				where: mocks.servers,
				innerJoin: () => ({ where: async () => [] }),
			}),
		}),
	},
}));

const { notificationRouter } = await import(
	"@/server/api/routers/notification"
);
const { adminRouter } = await import("@/server/api/routers/admin");
const caller = notificationRouter.createCaller({
	session: null,
	user: null,
} as never);
const alert = {
	ServerType: "Remote" as const,
	Type: "Inotify" as const,
	Value: 100,
	Threshold: 100,
	Message: "Host UID 1000 has an estimated 128 inotify instances (limit 128)",
	Timestamp: "2026-01-01T00:00:00Z",
	Token: "monitoring-test-token",
};
const monitoringConfig = {
	server: {
		refreshRate: 60,
		port: 4500,
		token: alert.Token,
		urlCallback:
			"https://dokploy.example/api/trpc/notification.receiveNotification",
		retentionDays: 2,
		cronJob: "0 0 * * *",
		thresholds: { cpu: 0, memory: 0 },
	},
	containers: { refreshRate: 60, services: { include: [], exclude: [] } },
};

describe("inotify notification routing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.settings.mockResolvedValue({
			metricsConfig: {
				server: { token: alert.Token, organizationId: "owner-org" },
			},
		});
		mocks.servers.mockResolvedValue([
			{ organizationId: "server-org", name: "Test server" },
		]);
		mocks.findOwner.mockResolvedValue({ organizationId: "fallback-owner-org" });
		mocks.updateSettings.mockResolvedValue({});
		mocks.setupMonitoring.mockResolvedValue(undefined);
	});

	it("sends an inotify alert only to the organization matched by the remote token", async () => {
		await caller.receiveNotification(alert);
		expect(mocks.send).toHaveBeenCalledExactlyOnceWith("server-org", {
			...alert,
			ServerName: "Test server",
		});
	});

	it("rejects an unknown remote token without dispatching", async () => {
		mocks.servers.mockResolvedValue([]);
		await expect(caller.receiveNotification(alert)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("rejects an incorrect local token without resolving recipients", async () => {
		await expect(
			caller.receiveNotification({
				...alert,
				ServerType: "Dokploy",
				Token: "wrong-token",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.findOwner).not.toHaveBeenCalled();
	});

	it("sends a local alert only to its stamped organization", async () => {
		await caller.receiveNotification({ ...alert, ServerType: "Dokploy" });
		expect(mocks.send).toHaveBeenCalledExactlyOnceWith("owner-org", {
			...alert,
			ServerType: "Dokploy",
			ServerName: "Dokploy",
		});
	});

	it("sends a legacy local alert to the owner fallback", async () => {
		mocks.settings.mockResolvedValue({
			metricsConfig: { server: { token: alert.Token } },
		});
		await caller.receiveNotification({ ...alert, ServerType: "Dokploy" });
		expect(mocks.findOwner).toHaveBeenCalledExactlyOnceWith();
		expect(mocks.send).toHaveBeenCalledExactlyOnceWith("fallback-owner-org", {
			...alert,
			ServerType: "Dokploy",
			ServerName: "Dokploy",
		});
	});

	it("stamps the active organization instead of accepting a client value", async () => {
		const adminCaller = adminRouter.createCaller({
			session: { activeOrganizationId: "admin-org" },
			user: { role: "admin" },
		} as never);

		await adminCaller.setupMonitoring({
			metricsConfig: {
				...monitoringConfig,
				server: { ...monitoringConfig.server, organizationId: "forged-org" },
			},
		} as never);

		expect(mocks.updateSettings).toHaveBeenCalledWith({
			metricsConfig: expect.objectContaining({
				server: expect.objectContaining({ organizationId: "admin-org" }),
			}),
		});
	});
});
