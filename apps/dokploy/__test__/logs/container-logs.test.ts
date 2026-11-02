import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { getContainerLogs } from "@dokploy/server/services/docker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "dokploy-log-reader-"));
	writeFileSync(
		join(directory, "docker"),
		`#!/bin/sh
case "$1 $2" in
  'ps -q') printf '%s' "$LOG_CONTAINER" ;;
  'service ls') printf '%s' "$LOG_SERVICE" ;;
  'container logs'|'service logs')
    printf '%s' "$LOG_STDOUT"
    printf '%s' "$LOG_STDERR" >&2
    exit "$LOG_EXIT"
    ;;
  *) exit 64 ;;
esac
`,
		{ mode: 0o755 },
	);
	vi.stubEnv("PATH", `${directory}:${env.PATH}`);
	vi.stubEnv("LOG_CONTAINER", "container-id\n");
	vi.stubEnv("LOG_SERVICE", "service-id\n");
	vi.stubEnv("LOG_STDOUT", "An ordinary log line\n");
	vi.stubEnv("LOG_STDERR", "");
	vi.stubEnv("LOG_EXIT", "0");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

describe("container log reads through the real shell executor", () => {
	it.each(["container-id\n", ""])(
		"returns an empty result when a successful log read has no search matches (container=%j)",
		async (container) => {
			vi.stubEnv("LOG_CONTAINER", container);
			await expect(
				getContainerLogs(
					"application",
					20,
					"2h",
					"Sitemap refresh scheduler finished",
				),
			).resolves.toBe("");
		},
	);

	it("filters literal text case-insensitively without changing matching lines", async () => {
		vi.stubEnv("LOG_STDOUT", "skip\nA -Worker.Ready line\r\nworkerXready\n");
		await expect(
			getContainerLogs("container-id", 20, "all", "-worker.ready", null, true),
		).resolves.toBe("A -Worker.Ready line\r\n");
	});

	it.each([undefined, ""])(
		"keeps unfiltered output intact for search %j",
		async (search) => {
			await expect(
				getContainerLogs("application", 20, "all", search),
			).resolves.toBe("An ordinary log line\n");
		},
	);

	it("includes application stderr in successful filtered log reads", async () => {
		vi.stubEnv("LOG_STDERR", "Scheduler FINISHED\n");
		await expect(
			getContainerLogs("application", 20, "2h", "finished"),
		).resolves.toBe("Scheduler FINISHED\n");
	});

	it.each([undefined, "Sitemap refresh scheduler finished"])(
		"propagates a Docker failure for search %j",
		async (search) => {
			vi.stubEnv("LOG_EXIT", "1");
			vi.stubEnv("LOG_STDERR", "Cannot connect to the Docker daemon\n");
			await expect(
				getContainerLogs("application", 20, "2h", search),
			).rejects.toMatchObject({ exitCode: 1 });
		},
	);
});
