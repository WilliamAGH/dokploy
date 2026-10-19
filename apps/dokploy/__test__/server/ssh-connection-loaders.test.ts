import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { transform } from "esbuild";
import { type Connection, Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const clientKey = utils.generateKeyPairSync("ed25519");
const clients = new Set<Connection>();
let connections = 0;
let port = 0;
const server = new Server(
	{ hostKeys: [utils.generateKeyPairSync("ed25519").private] },
	(client) => {
		connections++;
		clients.add(client);
		client.on("error", () => {});
		client.on("close", () => clients.delete(client));
		client.on("authentication", (ctx) => ctx.accept());
		client.on("ready", () =>
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					const channel = acceptExec();
					let stdin = "";
					channel.on("data", (data: Buffer) => {
						stdin += data;
					});
					channel.on("end", () => {
						const shell = spawn("sh", ["-c", info.command], {
							stdio: ["pipe", "pipe", "pipe"],
						});
						shell.stdout.pipe(channel, { end: false });
						shell.stderr.pipe(channel.stderr, { end: false });
						shell.on("close", (code) => {
							channel.exit(code ?? 1);
							channel.end();
						});
						shell.stdin.on("error", (error: NodeJS.ErrnoException) => {
							if (error.code !== "EPIPE") throw error;
						});
						shell.stdin.end(stdin);
					});
				});
			}),
		);
	},
);
beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
	for (const client of clients) client.end();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("SSH state across native loaders", () => {
	it("shares login and backoff across two native module copies", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ssh-loaders-"));
		let attempts = 0;
		const dead = net.createServer((socket) => {
			attempts++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
		try {
			// Native imports bypass Vitest's module cache and global context. Only
			// transpile: both files execute the actual helper, with real ssh2 clients.
			const source = await readFile(
				new URL(
					"../../../../packages/server/src/utils/servers/ssh-connection.ts",
					import.meta.url,
				),
				"utf8",
			);
			const { code } = await transform(source, {
				loader: "ts",
				format: "esm",
				target: "node22",
			});
			await symlink(
				resolve(__dirname, "../../node_modules"),
				join(dir, "node_modules"),
				"dir",
			);
			await Promise.all(
				["a.mjs", "b.mjs"].map((name) => writeFile(join(dir, name), code)),
			);
			const target = {
				serverId: "native-row-a",
				ipAddress: "127.0.0.1",
				port,
				username: "native-twins",
				privateKey: clientKey.private,
			};
			const before = connections;
			const { stdout } = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`
					import assert from "node:assert/strict";
					import { pathToFileURL } from "node:url";
					const [a, b] = await Promise.all(process.argv.slice(1, 3).map((path) => import(pathToFileURL(path).href)));
					assert.notEqual(a.openExecChannel, b.openExecChannel);
					const target = JSON.parse(process.argv[3]);
					// Hold just two channels: capacity cannot explain a second login.
					const channels = await Promise.all([a, b].map((loader, i) => loader.openExecChannel(
						{ ...target, serverId: "native-row-" + i }, loader.REMOTE_SCRIPT_RUNNER,
					)));
					await Promise.all(channels.map((channel, i) => new Promise((resolve, reject) => {
						let output = "";
						channel.on("data", (data) => { output += data; });
						channel.on("error", reject);
						channel.on("close", (code) => {
							try { assert.equal(code, 0); assert.equal(output, "native-" + i + "\\n"); resolve(); }
							catch (error) { reject(error); }
						});
						channel.end("echo native-" + i + "\\n");
					})));
					const dead = { ...target, port: Number(process.argv[4]) };
					// First failure through a, second through b must park both copies.
					for (const [i, loader] of [a, b, a, b, a, b].entries()) {
						await assert.rejects(loader.openExecChannel({ ...dead, serverId: "dead-row-" + (i % 2) }, "true"),
							/Connection lost before handshake|Connection lost before login|ECONNRESET/);
					}
					console.log("native channels and shared backoff exercised");
					// Server-side teardown closes the pool. No production global cleanup hooks.
					process.exit(0);
				`,
					join(dir, "a.mjs"),
					join(dir, "b.mjs"),
					JSON.stringify(target),
					String((dead.address() as AddressInfo).port),
				],
				{ timeout: 10_000, killSignal: "SIGKILL" },
			);
			expect(stdout.trim()).toBe(
				"native channels and shared backoff exercised",
			);
			expect({ logins: connections - before, attempts }).toEqual({
				logins: 1,
				attempts: 2,
			});
		} finally {
			await new Promise<void>((resolve) => dead.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
