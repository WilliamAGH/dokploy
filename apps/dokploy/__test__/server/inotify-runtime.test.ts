import { getInotifyUsage } from "@dokploy/server/services/inotify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn() }));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.local,
	execAsyncRemote: mocks.remote,
}));

const sample = (rows = "") => ({
	stdout: `limits\t524288\t128\t16384\ndaemon\t0\n${rows}end\n`,
	stderr: "",
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.local.mockResolvedValue(sample());
	mocks.remote.mockResolvedValue(sample());
});

describe("shared host inotify collector", () => {
	it("dispatches locally or through the selected server's existing transport", async () => {
		await getInotifyUsage();
		await getInotifyUsage("remote-id");
		expect(mocks.local).toHaveBeenCalledTimes(1);
		expect(mocks.remote).toHaveBeenCalledExactlyOnceWith(
			"remote-id",
			expect.any(String),
		);
	});

	it("aggregates instance counts per real UID and retains zero-count execution users", async () => {
		mocks.remote.mockResolvedValue(
			sample(
				"execution\t1000\nuser\t0\t14\t10\nuser\t0\t2\t2\nuser\t2345\t7\t7\n",
			),
		);
		const result = await getInotifyUsage("remote-id");
		expect(result).toMatchObject({
			defaultUid: 0,
			maxInstances: 128,
			persisted: null,
		});
		expect(result.error).toBeUndefined();
		expect(result.users).toEqual([
			{
				uid: 0,
				username: null,
				currentInstances: 12,
				descriptorReferences: 16,
			},
			{
				uid: 1000,
				username: null,
				currentInstances: 0,
				descriptorReferences: 0,
			},
			{
				uid: 2345,
				username: null,
				currentInstances: 7,
				descriptorReferences: 7,
			},
		]);
	});

	it.each([
		"limits\t524288\t128\t16384\ndaemon\t0\nuser\t0\t12\t12\n",
		"limits\t524288\t0\t16384\ndaemon\t0\nend\n",
		"limits\t524288\t128\t16384\ndaemon\t0\ndaemon\t1000\nend\n",
		"limits\t524288\t128\t16384\ndaemon\t0\nuser\t0\t-1\t-1\nend\n",
		"limits\t524288\t128\t16384\ndaemon\t0\nuser\t0\t2\nend\n",
		"limits\t524288\t128\t16384\ndaemon\t0\nuser\t0\t2\t3\nend\n",
		"limits\t524288\t128\t16384\ndaemon\t0\nend\nend\n",
	])(
		"rejects incomplete or invalid evidence without presenting a healthy count",
		async (stdout) => {
			mocks.local.mockResolvedValue({ stdout, stderr: "" });
			const result = await getInotifyUsage();
			expect(result.error).toBeTruthy();
			expect(result.users).toEqual([]);
		},
	);

	it("coalesces overlapping reads of one target but keeps different targets independent", async () => {
		let resolve!: (reply: ReturnType<typeof sample>) => void;
		mocks.remote.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const first = getInotifyUsage("same-server");
		const second = getInotifyUsage("same-server");
		expect(first).toBe(second);
		await getInotifyUsage();
		expect(mocks.local).toHaveBeenCalledTimes(1);
		expect(mocks.remote).toHaveBeenCalledTimes(1);
		resolve(sample());
		await first;
	});

	it("releases failed reads so the next request can recover", async () => {
		mocks.local.mockRejectedValueOnce(new Error("transport unavailable"));
		expect((await getInotifyUsage()).error).toBeTruthy();
		expect((await getInotifyUsage()).error).toBeUndefined();
		expect(mocks.local).toHaveBeenCalledTimes(2);
	});
});
