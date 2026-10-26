import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createRestartSafeBackupCommand,
	createVolumeArchiveCommand,
} from "@dokploy/server/utils/volume-backups/backup";
import { describe, expect, it } from "vitest";

const runCommand = (command: string) =>
	spawnSync("bash", ["-c", command], {
		encoding: "utf8",
	});

const outputLines = (stdout: string) =>
	stdout
		.trim()
		.split("\n")
		.filter((line) => line.length > 0);

describe("createRestartSafeBackupCommand", () => {
	it("restarts the service and preserves the backup error status", () => {
		const result = runCommand(
			createRestartSafeBackupCommand({
				stopCommand: 'echo "stop"',
				backupCommand: 'echo "backup"; exit 23',
				startCommand: 'echo "start"',
				uploadCommand: 'echo "upload"',
			}),
		);

		expect(result.status).toBe(23);
		expect(outputLines(result.stdout)).toEqual(["stop", "backup", "start"]);
	});

	it("preserves the backup error status when the restart also fails", () => {
		const result = runCommand(
			createRestartSafeBackupCommand({
				stopCommand: 'echo "stop"',
				backupCommand: 'echo "backup"; exit 23',
				startCommand: 'echo "start"; exit 17',
				uploadCommand: 'echo "upload"',
			}),
		);

		expect(result.status).toBe(23);
		expect(outputLines(result.stdout)).toEqual([
			"stop",
			"backup",
			"start",
			"Service restart also failed with exit code 17",
		]);
	});

	it("returns the restart error status when the backup succeeds", () => {
		const result = runCommand(
			createRestartSafeBackupCommand({
				stopCommand: 'echo "stop"',
				backupCommand: 'echo "backup"',
				startCommand: 'echo "start"; exit 17',
				uploadCommand: 'echo "upload"',
			}),
		);

		expect(result.status).toBe(17);
		expect(outputLines(result.stdout)).toEqual(["stop", "backup", "start"]);
	});

	it("uploads only after a successful backup and service restart", () => {
		const result = runCommand(
			createRestartSafeBackupCommand({
				stopCommand: 'echo "stop"',
				backupCommand: 'echo "backup"',
				startCommand: 'echo "start"',
				uploadCommand: 'echo "upload"',
			}),
		);

		expect(result.status).toBe(0);
		expect(outputLines(result.stdout)).toEqual([
			"stop",
			"backup",
			"start",
			"upload",
		]);
	});
});

describe("createVolumeArchiveCommand", () => {
	const runArchiveWithTarExit = (tarExitCode: number) => {
		const binDir = mkdtempSync(path.join(tmpdir(), "volume-archive-"));
		const tarPath = path.join(binDir, "tar");
		writeFileSync(tarPath, `#!/bin/sh\nexit ${tarExitCode}\n`);
		chmodSync(tarPath, 0o755);
		return spawnSync("bash", ["-c", createVolumeArchiveCommand("v.tar")], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		}).status;
	};

	it("accepts files that changed while a live volume was archived", () => {
		expect(runArchiveWithTarExit(1)).toBe(0);
	});

	it("fails on a fatal tar error", () => {
		expect(runArchiveWithTarExit(2)).not.toBe(0);
	});
});
