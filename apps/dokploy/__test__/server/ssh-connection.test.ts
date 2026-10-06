import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { REMOTE_SCRIPT_RUNNER } from "@dokploy/server/utils/servers/ssh-connection";
import { type Connection, Server, type ServerChannel, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findServerById: vi.fn() }));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
}));

const MARKER = "SECRET-MARKER-123";

// A real SSH server that records what reaches it: connections, exec request text,
// and the bytes each channel receives on stdin.
const hostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519");
let connections = 0;
let refuseNextSession = false;
const execs: string[] = [];
const stdins: string[] = [];
const clients = new Set<Connection>();

const runScript = (script: string, channel: ServerChannel) => {
	const bash = spawn("bash", [], { stdio: ["pipe", "pipe", "pipe"] });
	bash.stdout.pipe(channel, { end: false });
	bash.stderr.pipe(channel.stderr, { end: false });
	bash.on("close", (code) => {
		channel.exit(code ?? 1);
		channel.end();
	});
	bash.stdin.end(script);
};

const answerPing = (channel: ServerChannel) => {
	channel.once("data", () => {
		channel.write(
			"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
		);
		channel.exit(0);
		channel.end();
	});
};

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
	connections++;
	clients.add(client);
	client.on("close", () => clients.delete(client));
	client.on("authentication", (ctx) => ctx.accept());
	client.on("ready", () => {
		client.on("session", (accept, reject) => {
			if (refuseNextSession) {
				refuseNextSession = false;
				reject();
				return;
			}
			accept().on("exec", (acceptExec, _reject, info) => {
				const channel = acceptExec();
				execs.push(info.command);
				if (info.command === "docker system dial-stdio") {
					answerPing(channel);
					return;
				}
				let stdin = "";
				channel.on("data", (chunk: Buffer) => {
					stdin += chunk.toString();
				});
				channel.on("end", () => {
					stdins.push(stdin);
					runScript(stdin, channel);
				});
			});
		});
	});
});

let port = 0;
const serverRow = (serverId: string) => ({
	serverId,
	ipAddress: "127.0.0.1",
	port,
	username: "root",
	sshKeyId: "key",
	sshKey: { privateKey: clientKey.private },
});

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	mocks.findServerById.mockImplementation(async (serverId: string) =>
		serverRow(serverId),
	);
});

afterAll(async () => {
	for (const client of clients) client.end();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("execAsyncRemote over a pooled SSH connection", () => {
	it("runs sequential commands over one login", async () => {
		const before = connections;
		for (let i = 0; i < 6; i++) {
			const { stdout } = await execAsyncRemote("srv-seq", `echo run-${i}`);
			expect(stdout).toBe(`run-${i}\n`);
		}
		expect(connections - before).toBe(1);
	});

	it("opens one more connection per eight concurrent channels", async () => {
		const before = connections;
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				execAsyncRemote("srv-par", `sleep 0.3; echo par-${i}`),
			),
		);
		expect(results.map((r) => r.stdout)).toEqual(
			Array.from({ length: 20 }, (_, i) => `par-${i}\n`),
		);
		expect(connections - before).toBe(3);
	});

	it("reports a failing command's exit code and output", async () => {
		const failure = execAsyncRemote("srv-seq", "echo before; exit 3");
		await expect(failure).rejects.toBeInstanceOf(ExecError);
		await expect(failure).rejects.toMatchObject({
			exitCode: 3,
			stdout: "before\n",
		});
	});

	it("keeps the script, and any credential in it, out of the exec request", async () => {
		const from = execs.length;
		await execAsyncRemote(
			"srv-seq",
			`printf %s '${MARKER}' | wc -c; echo done`,
		);
		const sent = execs.slice(from);
		expect(sent).toEqual([REMOTE_SCRIPT_RUNNER]);
		expect(sent.join("")).not.toContain(MARKER);
		expect(stdins.at(-1)).toContain(MARKER);
	});

	it("retries a refused channel on a fresh connection", async () => {
		await execAsyncRemote("srv-retry", "true");
		const before = connections;
		refuseNextSession = true;
		const { stdout } = await execAsyncRemote("srv-retry", "echo recovered");
		expect(stdout).toBe("recovered\n");
		expect(connections - before).toBe(1);
	});
});

describe("getRemoteDocker over a pooled SSH connection", () => {
	it("carries every Docker API request on one login", async () => {
		const before = connections;
		const docker = await getRemoteDocker("srv-docker");
		for (let i = 0; i < 5; i++) {
			expect(String(await docker.ping())).toBe("OK");
		}
		expect(connections - before).toBe(1);
	});
});

describe("execAsync on the local host", () => {
	it("keeps the command text out of the shell's arguments", async () => {
		const { stdout } = await execAsync(
			`tr '\\0' ' ' < /proc/$$/cmdline; echo; : ${MARKER}`,
		);
		expect(stdout).toMatch(/^\/bin\/sh \S+script\.sh/);
		expect(stdout).not.toContain(MARKER);
	});

	it("runs the requested shell", async () => {
		const { stdout } = await execAsync('echo "${BASH_VERSION:-none}"', {
			shell: "/bin/bash",
		});
		expect(stdout.trim()).not.toBe("none");
	});

	it("reports a local failure without the command text", async () => {
		const failure = execAsync(`exit 4; : ${MARKER}`);
		await expect(failure).rejects.toMatchObject({ exitCode: 4 });
		await expect(failure).rejects.toSatisfy(
			(error: Error) => !error.message.includes(MARKER),
		);
	});
});
