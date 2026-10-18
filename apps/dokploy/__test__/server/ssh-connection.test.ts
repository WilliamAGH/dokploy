import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	WriteFileRemoteError,
	writeFileRemote,
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
const DROP = "DROP-CONNECTION-MID-COMMAND";

// A real SSH server that records what reaches it: connections, exec request text,
// and the bytes each channel receives on stdin.
const hostKey = utils.generateKeyPairSync("ed25519");
const clientKey = utils.generateKeyPairSync("ed25519");
let connections = 0;
let refuseNextSession = false;
let sessionDelayMs = 0;
const execs: string[] = [];
const stdins: string[] = [];
const clients = new Set<Connection>();

// Runs the exec request text through a shell, as sshd does, feeding it the bytes
// the client sent on stdin.
const runExec = (command: string, stdin: string, channel: ServerChannel) => {
	const shell = spawn("sh", ["-c", command], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	shell.stdout.pipe(channel, { end: false });
	shell.stderr.pipe(channel.stderr, { end: false });
	shell.on("close", (code) => {
		channel.exit(code ?? 1);
		channel.end();
	});
	// sshd discards stdin a command exits without reading (`cat > /missing/dir`
	// fails its redirect first); writing to that dead pipe raises EPIPE, which
	// only the real server would absorb.
	shell.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
	shell.stdin.end(stdin);
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
		client.on("session", async (accept, reject) => {
			if (refuseNextSession) {
				refuseNextSession = false;
				reject();
				return;
			}
			if (sessionDelayMs)
				await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
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
					if (stdin.includes(DROP)) {
						client.end();
						return;
					}
					runExec(info.command, stdin, channel);
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

	it("names a dropped connection instead of an undefined exit code", async () => {
		const failure = execAsyncRemote("srv-drop", `echo ${DROP}`);
		await expect(failure).rejects.toThrow(
			/SSH connection closed before the command finished/,
		);
		await expect(failure).rejects.not.toThrow(/undefined/);
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

	it("reuses an idle connection for a once-a-minute caller", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const before = connections;
			await execAsyncRemote("srv-idle", "true");
			vi.advanceTimersByTime(60_000);
			await execAsyncRemote("srv-idle", "true");
			expect(connections - before).toBe(1);
			vi.advanceTimersByTime(150_000);
			await execAsyncRemote("srv-idle", "true");
			expect(connections - before).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("writeFileRemote over a pooled SSH connection", () => {
	it("writes the content to a path that needs quoting, on the pooled login", async () => {
		const dir = await mkdtemp(join(tmpdir(), "write-remote-"));
		const target = join(dir, "it's a file.yml");
		await execAsyncRemote("srv-write", "true");
		const before = connections;
		await writeFileRemote("srv-write", target, `http:\n  ${MARKER}\n`);
		expect(await readFile(target, "utf8")).toBe(`http:\n  ${MARKER}\n`);
		expect(connections - before).toBe(0);
	});

	it("writes a path holding both a quote and an exclamation mark under its own name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "write-remote-"));
		const target = join(dir, "it's live!.yml");
		await writeFileRemote("srv-write", target, "x");
		expect(await readFile(target, "utf8")).toBe("x");
	});

	it("rejects with the remote error when the file cannot be written", async () => {
		const failure = writeFileRemote(
			"srv-write",
			"/nonexistent-dir/file.yml",
			"x",
		);
		await expect(failure).rejects.toBeInstanceOf(WriteFileRemoteError);
		await expect(failure).rejects.toThrow(/nonexistent-dir/);
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

	it("frees the slot of a request aborted before its channel opened", async () => {
		const docker = await getRemoteDocker("srv-abort");
		await docker.ping();
		const before = connections;
		sessionDelayMs = 300;
		// Seven, not eight: the warm-up ping's channel may still hold the eighth slot
		// for a moment. Seven leaked slots would still push the next eight pings onto
		// a second connection.
		const aborted = await Promise.allSettled(
			Array.from({ length: 7 }, () =>
				docker.listContainers({ abortSignal: AbortSignal.timeout(50) }),
			),
		);
		sessionDelayMs = 0;
		expect(aborted.every((r) => r.status === "rejected")).toBe(true);
		// Let the delayed channels open and be torn down.
		await new Promise((resolve) => setTimeout(resolve, 800));
		await Promise.all(Array.from({ length: 8 }, () => docker.ping()));
		expect(connections - before).toBe(0);
	});
});

describe("execAsync on the local host", () => {
	it("keeps the command text out of the shell's arguments", async () => {
		const { stdout } = await execAsync(
			`tr '\\0' ' ' < /proc/$$/cmdline; echo; : ${MARKER}`,
		);
		expect(stdout).toMatch(/^\/bin\/sh -c eval/);
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

describe("a server that cannot complete a login", () => {
	it("retries a single failed login at once, then costs one attempt per backoff window", async () => {
		let attempts = 0;
		const dead = net.createServer((socket) => {
			attempts++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
		const deadPort = (dead.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-dead"
				? { ...serverRow(serverId), port: deadPort }
				: serverRow(serverId),
		);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (let i = 0; i < 5; i++) {
				await expect(execAsyncRemote("srv-dead", "true")).rejects.toThrow(
					/SSH connection error/,
				);
			}
			// The second consecutive failure parks it; the old pool made five attempts.
			expect(attempts).toBe(2);
			// Past the first window's 30 s ceiling.
			vi.setSystemTime(Date.now() + 31_000);
			await expect(execAsyncRemote("srv-dead", "true")).rejects.toThrow(
				/SSH connection error/,
			);
			expect(attempts).toBe(3);
		} finally {
			vi.useRealTimers();
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			await new Promise<void>((resolve) => dead.close(() => resolve()));
		}
	});

	it("counts a failure older than the longest window as a first one", async () => {
		let attempts = 0;
		const dead = net.createServer((socket) => {
			attempts++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
		const deadPort = (dead.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-stale"
				? { ...serverRow(serverId), port: deadPort }
				: serverRow(serverId),
		);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const fails = () =>
				expect(execAsyncRemote("srv-stale", "true")).rejects.toThrow(
					/SSH connection error/,
				);
			await fails();
			vi.setSystemTime(Date.now() + 16 * 60_000);
			// A first failure again: it parks nothing, so the next call still dials.
			await fails();
			await fails();
			await fails();
			expect(attempts).toBe(3);
		} finally {
			vi.useRealTimers();
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			await new Promise<void>((resolve) => dead.close(() => resolve()));
		}
	});

	it("gives the next caller a fresh login after one dropped handshake", async () => {
		let attempts = 0;
		// Drops the first login, then relays every later one to the real server.
		const flaky = net.createServer((socket) => {
			attempts++;
			if (attempts === 1) {
				socket.destroy();
				return;
			}
			const upstream = net.connect(port, "127.0.0.1");
			socket.pipe(upstream).pipe(socket);
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
		});
		await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
		const flakyPort = (flaky.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-flaky"
				? { ...serverRow(serverId), port: flakyPort }
				: serverRow(serverId),
		);
		try {
			await expect(execAsyncRemote("srv-flaky", "true")).rejects.toThrow(
				/SSH connection error/,
			);
			const { stdout } = await execAsyncRemote("srv-flaky", "echo back");
			expect(stdout.trim()).toBe("back");
			expect(attempts).toBe(2);
		} finally {
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => flaky.close(() => resolve()));
		}
	});

	it("never parks a server beside its live login", async () => {
		let attempts = 0;
		// Relays the first login, drops the next two, relays every later one.
		const relay = net.createServer((socket) => {
			attempts++;
			if (attempts === 2 || attempts === 3) {
				socket.destroy();
				return;
			}
			const upstream = net.connect(port, "127.0.0.1");
			socket.pipe(upstream).pipe(socket);
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
		});
		await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
		const relayPort = (relay.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-relay"
				? { ...serverRow(serverId), port: relayPort }
				: serverRow(serverId),
		);
		try {
			await execAsyncRemote("srv-relay", "true");
			const from = stdins.length;
			const busy = Array.from({ length: 8 }, () =>
				execAsyncRemote("srv-relay", "sleep 1.5"),
			);
			// Every channel of the live login is open before the next logins drop.
			while (stdins.length - from < 8)
				await new Promise((resolve) => setTimeout(resolve, 20));
			for (let i = 0; i < 2; i++)
				await expect(execAsyncRemote("srv-relay", "true")).rejects.toThrow(
					/SSH connection error/,
				);
			const { stdout } = await execAsyncRemote(
				"srv-relay",
				"echo still-served",
			);
			expect(stdout).toBe("still-served\n");
			expect(attempts).toBe(4);
			await Promise.all(busy);
		} finally {
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			for (const client of clients) client.end();
			await new Promise<void>((resolve) => relay.close(() => resolve()));
		}
	});

	it("fails a login the server drops after its banner instead of hanging", async () => {
		const hangUp = net.createServer((socket) => {
			// Reading lets the server see the client's own FIN and close.
			socket.resume();
			socket.end("SSH-2.0-OpenSSH_9.9\r\n");
		});
		await new Promise<void>((resolve) => hangUp.listen(0, "127.0.0.1", resolve));
		const hangUpPort = (hangUp.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-hangup"
				? { ...serverRow(serverId), port: hangUpPort }
				: serverRow(serverId),
		);
		try {
			await expect(execAsyncRemote("srv-hangup", "true")).rejects.toThrow(
				/SSH connection error: Connection lost before login/,
			);
		} finally {
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			await new Promise<void>((resolve) => hangUp.close(() => resolve()));
		}
	});

	it("counts a burst of overlapping failed logins as one failure", async () => {
		let attempts = 0;
		const dead = net.createServer((socket) => {
			attempts++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
		const deadPort = (dead.address() as AddressInfo).port;
		mocks.findServerById.mockImplementation(async (serverId: string) =>
			serverId === "srv-burst"
				? { ...serverRow(serverId), port: deadPort }
				: serverRow(serverId),
		);
		try {
			// Sixteen callers need two logins; both fail inside one outage.
			await Promise.allSettled(
				Array.from({ length: 16 }, () => execAsyncRemote("srv-burst", "true")),
			);
			expect(attempts).toBe(2);
			// One counted failure parks nothing, so the next caller still tries a login.
			await expect(execAsyncRemote("srv-burst", "true")).rejects.toThrow(
				/SSH connection error/,
			);
			expect(attempts).toBe(3);
		} finally {
			mocks.findServerById.mockImplementation(async (serverId: string) =>
				serverRow(serverId),
			);
			await new Promise<void>((resolve) => dead.close(() => resolve()));
		}
	});

	it("leaves a reachable server's logins pooled", async () => {
		const before = connections;
		for (let i = 0; i < 3; i++) await execAsyncRemote("srv-reachable", "true");
		expect(connections - before).toBe(1);
	});
});
