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

const b64 = (value: string) => Buffer.from(value).toString("base64");
const reply = (extra: Record<string, unknown> = {}) => {
	mocks.exec.mockResolvedValue({
		stdout: JSON.stringify({
			inotifyMaxInstances: 128,
			inotifyMaxWatches: 524288,
			inotifyMaxQueuedEvents: 16384,
			inotifyDefaultUid: 0,
			inotifyExecutionUid: 1000,
			inotifyKnownUsersBase64: b64("0\troot\n1000\toperator\n"),
			inotifyUsersBase64: b64(
				"0\troot\t1\n0\troot\t1\n1000\toperator\t1\n2345\t\t1\n",
			),
			...extra,
		}),
		stderr: "",
	});
};

describe("per-user inotify health", () => {
	beforeEach(() => vi.clearAllMocks());

	it("groups host UIDs and defaults to Docker without summing users against one quota", async () => {
		reply();
		const { inotify } = await getServerHealth("test-org", "test-server");
		expect(inotify.defaultUid).toBe(0);
		expect(inotify.users).toEqual([
			{ uid: 0, username: "root", currentInstances: 2 },
			{ uid: 1000, username: "operator", currentInstances: 1 },
			{ uid: 2345, username: null, currentInstances: 1 },
		]);
		expect(inotify).not.toHaveProperty("currentInstances");
	});

	it("keeps daemon and execution UIDs selectable at zero and deduplicates equal UIDs", async () => {
		reply({
			inotifyUsersBase64: "",
			inotifyKnownUsersBase64: "",
			inotifyExecutionUid: 0,
		});
		const { inotify } = await getServerHealth("test-org", "test-server");
		expect(inotify.users).toEqual([
			{ uid: 0, username: null, currentInstances: 0 },
		]);
	});

	it("reports unreadable proc evidence as unavailable", async () => {
		reply({
			inotifyErrorBase64: b64("Host process descriptors could not be read"),
		});
		const { inotify } = await getServerHealth("test-org", "test-server");
		expect(inotify.error).toBe("Host process descriptors could not be read");
	});
});
