import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	candidateExec: vi.fn(),
	candidateInspect: vi.fn(),
	candidateRemove: vi.fn(),
	candidateRename: vi.fn(),
	candidateStart: vi.fn(),
	createContainer: vi.fn(),
	currentExec: vi.fn(),
	currentInspect: vi.fn(),
	currentRemove: vi.fn(),
	currentRename: vi.fn(),
	currentStart: vi.fn(),
	currentStop: vi.fn(),
	followProgress: vi.fn(),
	getRemoteDocker: vi.fn(),
	pull: vi.fn(),
}));

const execResponse = (payload = '{"providers":["Swarm","Docker","File"]}') => ({
	inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
	start: vi.fn(async () => {
		const stream = new PassThrough();
		queueMicrotask(() => stream.end(payload));
		return stream;
	}),
});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const {
	assertSwarmReadinessTraefikRuntime,
	initializeStandaloneTraefik,
	SWARM_READINESS_TRAEFIK_IMAGE,
	TRAEFIK_IMAGE,
} = await import("@dokploy/server/setup/traefik-setup");

describe("standalone Traefik reconciliation", () => {
	afterEach(() => vi.unstubAllEnvs());

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.currentInspect.mockResolvedValue({
			Id: "old-container-id-1234567890",
			Config: {
				Env: ["PRESERVED_SETTING=fake-value"],
				Image: "traefik:v3.6.25",
			},
			HostConfig: {
				PortBindings: {
					"80/tcp": [{ HostPort: "80" }],
					"443/tcp": [{ HostPort: "443" }],
					"443/udp": [{ HostPort: "443" }],
					"8080/tcp": [{ HostPort: "8080" }],
				},
			},
			NetworkSettings: {
				Networks: {
					"dokploy-network": {},
					"isolated-application": {},
				},
			},
			State: { Running: true, Restarting: false, Error: "" },
		});
		mocks.candidateInspect.mockResolvedValue({
			State: { Running: true, Restarting: false, Error: "" },
		});
		mocks.currentExec.mockImplementation(() => execResponse());
		mocks.candidateExec.mockImplementation(() => execResponse());

		const current = {
			exec: mocks.currentExec,
			inspect: mocks.currentInspect,
			remove: mocks.currentRemove,
			rename: mocks.currentRename,
			start: mocks.currentStart,
			stop: mocks.currentStop,
		};
		const candidate = {
			exec: mocks.candidateExec,
			inspect: mocks.candidateInspect,
			remove: mocks.candidateRemove,
			rename: mocks.candidateRename,
			start: mocks.candidateStart,
		};
		mocks.createContainer.mockResolvedValue(candidate);
		mocks.pull.mockImplementation(
			(_image: string, _options: object, callback: Function) =>
				callback(null, new PassThrough()),
		);
		mocks.followProgress.mockImplementation(
			(_stream: PassThrough, callback: Function) => callback(null),
		);
		mocks.getRemoteDocker.mockResolvedValue({
			createContainer: mocks.createContainer,
			getContainer: vi.fn(() => current),
			modem: { followProgress: mocks.followProgress },
			pull: mocks.pull,
		});
	});

	it("creates and verifies the candidate before retaining the current container as rollback", async () => {
		await initializeStandaloneTraefik({ serverId: "server-id" });

		expect(mocks.pull).toHaveBeenCalledWith(
			TRAEFIK_IMAGE,
			{},
			expect.any(Function),
		);
		const settings = mocks.createContainer.mock.calls[0]?.[0];
		expect(settings).toMatchObject({
			Image: TRAEFIK_IMAGE,
			Env: ["PRESERVED_SETTING=fake-value"],
			NetworkingConfig: {
				EndpointsConfig: {
					"dokploy-network": {},
					"isolated-application": {},
				},
			},
		});
		expect(settings.name).toMatch(/^dokploy-traefik-candidate-/);
		expect(settings.HostConfig.PortBindings["8080/tcp"]).toEqual([
			{ HostPort: "8080" },
		]);
		expect(mocks.createContainer.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.currentStop.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.currentRename).toHaveBeenCalledWith({
			name: "dokploy-traefik-rollback-old-containe",
		});
		expect(mocks.candidateRename).toHaveBeenCalledWith({
			name: "dokploy-traefik",
		});
		expect(mocks.candidateRename.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.candidateStart.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.candidateExec).toHaveBeenCalledWith(
			expect.objectContaining({
				Cmd: expect.arrayContaining(["http://127.0.0.1:8080/api/overview"]),
			}),
		);
		expect(mocks.currentRemove).not.toHaveBeenCalled();
		expect(mocks.candidateRemove).not.toHaveBeenCalled();
	});

	it("restores and verifies the prior container when the candidate cannot start", async () => {
		mocks.candidateStart.mockRejectedValueOnce(
			new Error("candidate start failed"),
		);

		await expect(
			initializeStandaloneTraefik({ serverId: "server-id" }),
		).rejects.toThrow("candidate start failed");

		expect(mocks.candidateRemove).toHaveBeenCalledWith({ force: true });
		expect(mocks.currentRename).toHaveBeenNthCalledWith(2, {
			name: "dokploy-traefik",
		});
		expect(mocks.currentStart).toHaveBeenCalledTimes(1);
		expect(mocks.currentExec).toHaveBeenCalledTimes(1);
		expect(mocks.currentStart.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.currentExec.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("restores the prior container when the candidate lacks required providers", async () => {
		vi.useFakeTimers();
		mocks.candidateExec.mockImplementation(() =>
			execResponse('{"providers":["Docker","File"]}'),
		);

		const reconciliation = expect(
			initializeStandaloneTraefik({ serverId: "server-id" }),
		).rejects.toThrow("Traefik API did not become ready");
		await vi.runAllTimersAsync();
		await reconciliation;

		expect(mocks.candidateRemove).toHaveBeenCalledWith({ force: true });
		expect(mocks.currentRename).toHaveBeenNthCalledWith(2, {
			name: "dokploy-traefik",
		});
		expect(mocks.currentStart).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it("rejects readiness when another Traefik image is running", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TRAEFIK_IMAGE", SWARM_READINESS_TRAEFIK_IMAGE);

		await expect(
			assertSwarmReadinessTraefikRuntime("server-id"),
		).rejects.toThrow("supported Traefik image to be running");
	});
});
