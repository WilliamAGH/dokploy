import { createHash } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { Client, type ClientChannel } from "ssh2";

// OpenSSH's default MaxSessions allows 10 channels per connection; stay under it.
const MAX_CHANNELS_PER_CONNECTION = 8;
// A connection with no open channel closes after this, so idle servers hold no session.
const IDLE_CLOSE_MS = 30_000;

/**
 * Wraps a command sent to a server. The script itself travels on the channel's
 * stdin into a 0600 temp file, so its text, including any inline credentials,
 * never appears in a process's arguments on the server.
 */
export const REMOTE_SCRIPT_RUNNER = `f=$(mktemp) && trap 'rm -f "$f"' EXIT && cat > "$f" && bash "$f" < /dev/null`;

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
			held.idleTimer = setTimeout(() => held.client.end(), IDLE_CLOSE_MS);
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
		entry.client.exec(command, (err, channel) => {
			if (err) {
				release();
				if (isChannelRefusal(err)) {
					entry.closed = true;
					if (entry.channels === 0) entry.client.end();
				}
				reject(err);
				return;
			}
			channel.once("close", release);
			resolve(channel);
		});
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
			(channel) => callback?.(null, channel),
			// Node's Agent ignores the stream when err is set (net.createConnection
			// passes none); @types/node still types it as required.
			(error: Error) => callback?.(error, undefined as unknown as Duplex),
		);
		return undefined;
	}
}
