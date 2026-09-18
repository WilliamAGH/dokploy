import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inotifyScanScript } from "@dokploy/server/services/inotify";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

// Captured from systemd-udevd on a Fedora 43 fleet host: the descriptor every
// (udev-worker) child inherits, and the one the collector overcounted.
const udevFdinfo = `pos:\t0
flags:\t02000000
mnt_id:\t19
ino:\t3089
inotify wd:11 ino:4c7 sdev:7 mask:8 ignored_mask:0 fhandle-bytes:c fhandle-type:1 f_handle:8051379ec704000000000000
inotify wd:f ino:4c6 sdev:7 mask:8 ignored_mask:0 fhandle-bytes:c fhandle-type:1 f_handle:036144b8c604000000000000
`;

const otherFdinfo = `pos:\t0
flags:\t02000000
mnt_id:\t19
ino:\t4102
inotify wd:1 ino:281 sdev:7 mask:8 ignored_mask:0 fhandle-bytes:c fhandle-type:1 f_handle:801d82668102000000000000
`;

const process_ = async (
	root: string,
	pid: number,
	fields: { name: string; ppid: number; uid: number },
	descriptors: Array<{ fd: number; fdinfo: string }> = [],
) => {
	const dir = join(root, String(pid));
	await mkdir(join(dir, "fd"), { recursive: true });
	await mkdir(join(dir, "fdinfo"), { recursive: true });
	await writeFile(
		join(dir, "status"),
		`Name:\t${fields.name}\nState:\tS (sleeping)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${fields.ppid}\nTracerPid:\t0\nUid:\t${fields.uid}\t${fields.uid}\t${fields.uid}\t${fields.uid}\n`,
	);
	for (const { fd, fdinfo } of descriptors) {
		await symlink("anon_inode:inotify", join(dir, "fd", String(fd)));
		await writeFile(join(dir, "fdinfo", String(fd)), fdinfo);
	}
};

let stdout = "";

beforeAll(async () => {
	const root = await mkdtemp(join(tmpdir(), "inotify-scan-"));
	await mkdir(join(root, "sys/fs/inotify"), { recursive: true });
	await writeFile(join(root, "sys/fs/inotify/max_user_watches"), "524288\n");
	await writeFile(join(root, "sys/fs/inotify/max_user_instances"), "512\n");
	await writeFile(join(root, "sys/fs/inotify/max_queued_events"), "16384\n");

	// One inotify instance held by systemd-udevd and inherited by two workers.
	await process_(root, 879, { name: "systemd-udevd", ppid: 1, uid: 0 }, [
		{ fd: 6, fdinfo: udevFdinfo },
	]);
	await process_(root, 12345, { name: "(udev-worker)", ppid: 879, uid: 0 }, [
		{ fd: 6, fdinfo: udevFdinfo },
	]);
	await process_(root, 12346, { name: "(udev-worker)", ppid: 879, uid: 0 }, [
		{ fd: 6, fdinfo: udevFdinfo },
	]);
	await process_(root, 2000, { name: "dockerd", ppid: 1, uid: 0 });
	// A child that opened its own instance is not a shared reference.
	await process_(root, 3000, { name: "watcher", ppid: 1, uid: 1000 }, [
		{ fd: 7, fdinfo: otherFdinfo },
	]);
	await process_(root, 3001, { name: "watcher", ppid: 3000, uid: 1000 }, [
		{ fd: 7, fdinfo: udevFdinfo },
	]);

	({ stdout } = await run("/bin/sh", ["-c", inotifyScanScript, "scan", root]));
}, 30_000);

describe("host inotify scan", () => {
	it("charges an instance inherited across fork() to its opener only", () => {
		expect(
			stdout.split("\n").filter((row) => row.startsWith("user\t0")),
		).toEqual(["user\t0\t1"]);
	});

	it("keeps instances a child opened for itself separate from the parent's", () => {
		expect(
			stdout.split("\n").filter((row) => row.startsWith("user\t1000")),
		).toEqual(["user\t1000\t1", "user\t1000\t1"]);
	});

	it("reports the host limits and the Docker daemon UID", () => {
		expect(stdout.startsWith("limits\t524288\t512\t16384\n")).toBe(true);
		expect(stdout).toContain("daemon\t0\n");
		expect(stdout.endsWith("end\n")).toBe(true);
	});
});
