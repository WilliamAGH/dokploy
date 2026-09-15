import {
	setupMonitoring,
	setupWebMonitoring,
} from "@dokploy/server/setup/monitoring-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	getWebServerSettings: vi.fn(),
	getDokployImageTag: vi.fn(),
	pullImage: vi.fn(),
	pullRemoteImage: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	getRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({ IS_CLOUD: false }));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));
vi.mock("@dokploy/server/services/settings", () => ({
	getDokployImageTag: mocks.getDokployImageTag,
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImage: mocks.pullImage,
	pullRemoteImage: mocks.pullRemoteImage,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const notFound = () =>
	Object.assign(new Error("not found"), { statusCode: 404 });

const createDocker = () => ({
	createService: vi.fn().mockResolvedValue(undefined),
	getContainer: vi.fn(() => ({
		remove: vi.fn().mockRejectedValue(notFound()),
	})),
	getService: vi.fn(() => ({
		inspect: vi.fn().mockRejectedValue(notFound()),
	})),
});

let remoteDocker: ReturnType<typeof createDocker>;
let webDocker: ReturnType<typeof createDocker>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NODE_ENV", "test");
	remoteDocker = createDocker();
	webDocker = createDocker();
	mocks.findServerById.mockResolvedValue({ metricsConfig: {} });
	mocks.getWebServerSettings.mockResolvedValue({
		metricsConfig: { server: { port: 4500 } },
	});
	mocks.getDokployImageTag.mockReturnValue("latest");
	mocks.execAsync.mockResolvedValue({ stderr: "", stdout: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stderr: "", stdout: "" });
	mocks.getRemoteDocker.mockImplementation((serverId?: string) =>
		Promise.resolve(serverId ? remoteDocker : webDocker),
	);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("monitoring image setup", () => {
	it("uses the image override and host-proc capability for remote monitoring", async () => {
		const image =
			"ghcr.io/williamagh/dokploy-monitoring@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		vi.stubEnv("MONITORING_IMAGE", image);

		await setupMonitoring("server-id");

		expect(mocks.pullRemoteImage).toHaveBeenCalledWith(image, "server-id");
		expect(remoteDocker.createService).toHaveBeenCalledWith(
			expect.objectContaining({
				TaskTemplate: expect.objectContaining({
					ContainerSpec: expect.objectContaining({
						CapabilityAdd: ["CAP_SYS_PTRACE"],
						Image: image,
					}),
				}),
			}),
		);
	});

	it("uses the upstream fallback and host-proc capability for local monitoring", async () => {
		await setupWebMonitoring();

		expect(mocks.pullImage).toHaveBeenCalledWith("dokploy/monitoring:latest");
		expect(webDocker.createService).toHaveBeenCalledWith(
			expect.objectContaining({
				TaskTemplate: expect.objectContaining({
					ContainerSpec: expect.objectContaining({
						CapabilityAdd: ["CAP_SYS_PTRACE"],
						Image: "dokploy/monitoring:latest",
					}),
				}),
			}),
		);
	});
});
