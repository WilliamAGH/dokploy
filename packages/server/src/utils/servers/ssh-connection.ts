import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel } from "ssh2";

// OpenSSH's default MaxSessions allows 10 channels per connection; stay under it.
// Every fleet server measured 10 or more on 2026-10-06.
const MAX_CHANNELS_PER_CONNECTION = 8;
// A connection with no open channel closes after this, so idle servers hold no session.
const IDLE_CLOSE_MS = 30_000;

/**
 * Runs the script that arrives on the channel's stdin. bash reads it through a
 * pipe (`/dev/fd/63`), so its text, including any inline credentials, never
 * appears in a process's arguments or on disk, and a full disk cannot stop a
 * cleanup script. The outer `exec bash -c` keeps this independent of the
 * user's login shell.
 */
export const REMOTE_SCRIPT_RUNNER = `exec bash -c 'bash <(cat) < /dev/null'`;

export interface SshTarget {
	serverId: string;
	ipAddress: string;
	port: number;
	username: string;
	privateKey: string;
}

interface PooledConnection {
	client: Client;
	ready: Promise<void>;
	channels: number;
	closed: boolean;
	idleTimer?: NodeJS.Timeout;
}

const pools = new Map<string, PooledConnection[]>();

// A changed address, user or key gets its own connection instead of reusing a stale one.
const poolKey = (target: SshTarget) =>
	[
		target.serverId,
		target.ipAddress,
		target.port,
		target.username,
		createHash("sha256").update(target.privateKey).digest("hex"),
	].join("\0");

const connect = (key: string, target: SshTarget): PooledConnection => {
	const client = new Client();
	const entry: PooledConnection = {
		client,
		ready: Promise.resolve(),
		channels: 0,
		closed: false,
	};
	const drop = () => {
		entry.closed = true;
		clearTimeout(entry.idleTimer);
		const remaining = (pools.get(key) ?? []).filter((e) => e !== entry);
		if (remaining.length) pools.set(key, remaining);
		else pools.delete(key);
	};
	entry.ready = new Promise((resolve, reject) => {
		client.once("ready", () => resolve());
		client.once("error", reject);
	});
	client.on("error", drop).on("close", drop).on("end", drop);
	client.connect({
		host: target.ipAddress,
		port: target.port,
		username: target.username,
		privateKey: target.privateKey,
		readyTimeout: 60_000,
		keepaliveInterval: 5_000,
		keepaliveCountMax: 3,
	});
	return entry;
};

// Ending a connection makes it unwritable at once, while its `close` arrives a
// round trip later; marking it closed first keeps new channels off it.
const retire = (entry: PooledConnection) => {
	entry.closed = true;
	if (entry.channels === 0) entry.client.end();
};

const acquire = (target: SshTarget) => {
	const key = poolKey(target);
	const list = pools.get(key) ?? [];
	let entry = list.find(
		(e) => !e.closed && e.channels < MAX_CHANNELS_PER_CONNECTION,
	);
	if (!entry) {
		entry = connect(key, target);
		pools.set(key, [...list, entry]);
	}
	const held = entry;
	held.channels++;
	clearTimeout(held.idleTimer);
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		held.channels--;
		if (held.channels > 0) return;
		if (held.closed) held.client.end();
		else {
			held.idleTimer = setTimeout(() => retire(held), IDLE_CLOSE_MS);
			held.idleTimer.unref();
		}
	};
	return { entry: held, release };
};

// A connection that refused a channel (dead link, or the server's session limit)
// takes no new channels; its open channels finish on it.
const isChannelRefusal = (error: unknown) =>
	error instanceof Error &&
	/channel open failure|not connected|no response from server/i.test(
		error.message,
	);

const execOnce = async (target: SshTarget, command: string) => {
	const { entry, release } = acquire(target);
	try {
		await entry.ready;
	} catch (error) {
		release();
		throw error;
	}
	return new Promise<ClientChannel>((resolve, reject) => {
		const refuse = (error: Error) => {
			release();
			if (isChannelRefusal(error)) retire(entry);
			reject(error);
		};
		try {
			entry.client.exec(command, (err, channel) => {
				if (err) {
					refuse(err);
					return;
				}
				channel.once("close", release);
				resolve(channel);
			});
		} catch (error) {
			// ssh2 throws "Not connected" synchronously once the socket stops being writable.
			refuse(error as Error);
		}
	});
};

/**
 * Opens an exec channel on the server's pooled connection. A refused channel is
 * retried once on a fresh connection; connection and authentication errors
 * propagate unchanged.
 */
export const openExecChannel = async (
	target: SshTarget,
	command: string,
): Promise<ClientChannel> => {
	try {
		return await execOnce(target, command);
	} catch (error) {
		if (!isChannelRefusal(error)) throw error;
		return execOnce(target, command);
	}
};

/**
 * An HTTP agent for Dockerode that carries each Docker API request over a
 * `docker system dial-stdio` channel on the server's pooled SSH connection,
 * as docker-modem's own SSH agent does, without a new login per request.
 */
export class PooledDockerAgent extends http.Agent {
	constructor(private readonly target: SshTarget) {
		super({ keepAlive: false });
	}

	override createConnection(
		_options: http.ClientRequestArgs,
		callback?: (err: Error | null, stream: Duplex) => void,
	): Duplex | null | undefined {
		openExecChannel(this.target, "docker system dial-stdio").then(
			(channel) => {
				// A request aborted before its channel opened gets the channel destroyed
				// unread. ssh2 emits `close`, which frees the pool slot, only after the
				// readable side ends, so drain it on destroy.
				const destroy = channel.destroy.bind(channel);
				channel.destroy = () => {
					channel.resume();
					return destroy();
				};
				callback?.(null, channel);
			},
			// Node's Agent ignores the stream when err is set (net.createConnection
			// passes none); @types/node still types it as required.
			(error: Error) => callback?.(error, undefined as unknown as Duplex),
		);
		return undefined;
	}
}
