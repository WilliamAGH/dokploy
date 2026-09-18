import { getServerHealth } from "@dokploy/server/services/server-health";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.exec,
	execAsyncRemote: mocks.exec,
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: async () => ({ listNetworks: async () => [] }),
}));

const reply = (
	rows = "execution\t1000\nuser\t0\t2\t1\nuser\t0\t1\t1\nuser\t1000\t1\t1\nuser\t2345\t1\t1\n",
	complete = true,
) => {
	mocks.exec.mockImplementation((_serverId: string, command: string) =>
		Promise.resolve({
			stdout: command.includes("docker run --rm")
				? `limits\t524288\t128\t16384\ndaemon\t0\n${rows}${complete ? "end\n" : ""}`
				: JSON.stringify({
						containerCount: 3,
						memTotalBytes: 1024,
						diskTotalBytes: 2048,
					}),
			stderr: "",
		}),
	);
};

describe("per-user inotify health", () => {
	beforeEach(() => vi.clearAllMocks());

	it("groups host UIDs and defaults to Docker without summing users against one quota", async () => {
		reply();
		const { inotify } = await getServerHealth("test-org", "test-server");
		expect(inotify.defaultUid).toBe(0);
		expect(inotify.users).toEqual([
			{ uid: 0, username: null, currentInstances: 2, descriptorReferences: 3 },
			{
				uid: 1000,
				username: null,
				currentInstances: 1,
				descriptorReferences: 1,
			},
			{
				uid: 2345,
				username: null,
				currentInstances: 1,
				descriptorReferences: 1,
			},
		]);
		expect(inotify).not.toHaveProperty("currentInstances");
	});

	it("keeps daemon and execution UIDs selectable at zero and deduplicates equal UIDs", async () => {
		reply("execution\t0\n");
		const { inotify } = await getServerHealth("test-org", "test-server");
		expect(inotify.users).toEqual([
			{ uid: 0, username: null, currentInstances: 0, descriptorReferences: 0 },
		]);
	});

	it("reports unreadable proc evidence as unavailable", async () => {
		reply("user\t0\t2\t2\n", false);
		const health = await getServerHealth("test-org", "test-server");
		expect(health.inotify.error).toBeTruthy();
		expect(health.inotify.users).toEqual([]);
		expect(health.containers.containerCount).toBe(3);
		expect(health.resources.memTotalBytes).toBe(1024);
		expect(health.disk.totalBytes).toBe(2048);
	});
});
