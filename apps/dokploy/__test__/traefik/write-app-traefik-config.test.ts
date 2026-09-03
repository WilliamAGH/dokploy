import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecError } from "@dokploy/server/utils/process/execAsync";
import {
	loadOrCreateConfigRemote,
	writeAppTraefikConfig,
	writeTraefikConfigRemote,
} from "@dokploy/server/utils/traefik/application";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsyncRemote: vi.fn(),
	writeFileRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@dokploy/server/utils/process/execAsync")
		>();
	return {
		...actual,
		execAsyncRemote: mocks.execAsyncRemote,
		writeFileRemote: mocks.writeFileRemote,
	};
});

describe("writeAppTraefikConfig", () => {
	let cwd: string;
	let dynamicPath: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-traefik-"));
		dynamicPath = path.join(cwd, ".docker", "traefik", "dynamic");
		fs.mkdirSync(dynamicPath, { recursive: true });
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	// Regression test for #5189: Traefik's file provider rejects a standalone
	// `routers: {}` / `services: {}` map and aborts its watcher for every
	// dynamic config once it hits one, so an app with no domains must never
	// get an on-disk config file at all.
	it("removes the file instead of writing empty routers/services", async () => {
		const appName = "no-domain-app";
		const configPath = path.join(dynamicPath, `${appName}.yml`);
		fs.writeFileSync(configPath, "stale content", "utf8");

		await writeAppTraefikConfig(
			{ http: { routers: {}, services: {} } },
			appName,
		);

		expect(fs.existsSync(configPath)).toBe(false);
	});

	it("writes the file when routers/services are present", async () => {
		const appName = "with-domain-app";
		const configPath = path.join(dynamicPath, `${appName}.yml`);

		await writeAppTraefikConfig(
			{
				http: {
					routers: {
						[`${appName}-router-1`]: {
							rule: "Host(`x`)",
							service: `${appName}-service`,
						},
					},
					services: {},
				},
			},
			appName,
		);

		expect(fs.existsSync(configPath)).toBe(true);
	});

	it("propagates local config write failures", async () => {
		const writeError = new Error("write failed");
		vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
			throw writeError;
		});

		await expect(
			writeAppTraefikConfig(
				{
					http: {
						routers: {
							"application-router-1": {
								rule: "Host(`x`)",
								service: "application-service",
							},
						},
						services: {},
					},
				},
				"application",
			),
		).rejects.toBe(writeError);
	});

	it("removes the remote file instead of writing empty routers/services", async () => {
		mocks.execAsyncRemote.mockResolvedValue({ stdout: "", stderr: "" });

		await writeAppTraefikConfig(
			{ http: { routers: {}, services: {} } },
			"no-domain-app",
			"server-id",
		);

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		const [, command] = mocks.execAsyncRemote.mock.calls[0] ?? [];
		expect(command).toMatch(/^rm -f /);
		expect(command).toContain("no-domain-app.yml");
	});

	it("writes the remote file when routers/services are present", async () => {
		mocks.writeFileRemote.mockResolvedValue(undefined);

		await writeAppTraefikConfig(
			{
				http: {
					routers: {
						"with-domain-app-router-1": {
							rule: "Host(`x`)",
							service: "with-domain-app-service",
						},
					},
					services: {},
				},
			},
			"with-domain-app",
			"server-id",
		);

		expect(mocks.writeFileRemote).toHaveBeenCalledOnce();
		const [serverId, remotePath, content] =
			mocks.writeFileRemote.mock.calls[0] ?? [];
		expect(serverId).toBe("server-id");
		expect(remotePath).toContain("with-domain-app.yml");
		expect(content).toContain("with-domain-app-router-1");
	});

	it("returns an empty config only when the remote file is absent", async () => {
		mocks.execAsyncRemote.mockRejectedValue(
			new ExecError("missing", {
				command: "cat",
				exitCode: 44,
				serverId: "server-id",
			}),
		);

		await expect(
			loadOrCreateConfigRemote("server-id", "missing-app"),
		).resolves.toEqual({ http: { routers: {}, services: {} } });
	});

	it("propagates remote config read failures", async () => {
		const readError = new ExecError("transport failed", {
			command: "cat",
			exitCode: 255,
			serverId: "server-id",
		});
		mocks.execAsyncRemote.mockRejectedValue(readError);

		await expect(
			loadOrCreateConfigRemote("server-id", "unreachable-app"),
		).rejects.toBe(readError);
	});

	it("propagates remote config parse failures", async () => {
		mocks.execAsyncRemote.mockResolvedValue({
			stdout: "http: [",
			stderr: "",
		});

		await expect(
			loadOrCreateConfigRemote("server-id", "invalid-app"),
		).rejects.toThrow();
	});

	it("propagates remote config write failures", async () => {
		const writeError = new Error("write failed");
		mocks.writeFileRemote.mockRejectedValue(writeError);

		await expect(
			writeTraefikConfigRemote(
				{ http: { routers: {}, services: {} } },
				"application",
				"server-id",
			),
		).rejects.toBe(writeError);
	});
});
