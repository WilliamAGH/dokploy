import { execFile, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { findServerById } from "@dokploy/server/services/server";
import { Client, type ClientChannel } from "ssh2";
import {
	openExecChannel,
	REMOTE_SCRIPT_RUNNER,
} from "../servers/ssh-connection";
import { ExecError } from "./ExecError";

export class WriteFileRemoteError extends Error {
	constructor(
		message: string,
		public readonly context: {
			remotePath: string;
			serverId: string;
			originalError: Error;
		},
	) {
		super(message);
		this.name = "WriteFileRemoteError";
	}
}

// Re-export ExecError for easier imports
export { ExecError } from "./ExecError";

interface ExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: string;
}

// The shell reads the command from fd 3, so its text, including inline
// credentials, never appears in a process's arguments, on disk, or in the error.
// Node backs extra stdio with a socketpair, which /dev/fd/3 cannot open, so the
// shell reads the descriptor directly.
const READ_SCRIPT_FROM_FD3 = 'eval "$(cat <&3)"';

const runShell = (
	command: string,
	options: ExecOptions,
	onData?: (data: string) => void,
): Promise<{ stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(
			options.shell ?? "/bin/sh",
			["-c", READ_SCRIPT_FROM_FD3],
			{
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe", "pipe"],
			},
		);
		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
			onData?.(data.toString());
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
			onData?.(data.toString());
		});
		child.on("error", (error) => {
			reject(
				new ExecError(`Command execution error: ${error.message}`, {
					command,
					stdout,
					stderr,
					originalError: error,
				}),
			);
		});
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(
				new ExecError(
					`Command execution failed: exit code ${code}${stderr ? `\n${stderr}` : ""}`,
					{ command, stdout, stderr, exitCode: code ?? undefined },
				),
			);
		});
		const script = child.stdio[3] as Writable;
		// A script that exits before reading all of itself closes the pipe; the
		// exit status above reports the outcome, so EPIPE carries no information.
		script.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") child.kill();
		});
		script.end(command);
	});

export const execAsync = (
	command: string,
	options: ExecOptions = {},
): Promise<{ stdout: string; stderr: string }> => runShell(command, options);

export const execAsyncStream = (
	command: string,
	onData?: (data: string) => void,
	options: Omit<ExecOptions, "shell"> = {},
): Promise<{ stdout: string; stderr: string }> =>
	runShell(command, options, onData);

export const execFileAsync = async (
	command: string,
	args: string[],
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	const child = execFile(command, args);

	if (options.input && child.stdin) {
		child.stdin.write(options.input);
		child.stdin.end();
	}

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(
					new Error(`Command failed with code ${code}. Stderr: ${stderr}`),
				);
			}
		});

		child.on("error", reject);
	});
};

export const execAsyncRemote = async (
	serverId: string | null,
	command: string,
	onData?: (data: string) => void,
): Promise<{ stdout: string; stderr: string }> => {
	if (!serverId) return { stdout: "", stderr: "" };
	const server = await findServerById(serverId);
	if (!server.sshKeyId || !server.sshKey)
		throw new Error("No SSH key available for this server");

	let channel: ClientChannel;
	try {
		channel = await openExecChannel(
			{
				serverId,
				ipAddress: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey.privateKey,
			},
			REMOTE_SCRIPT_RUNNER,
		);
	} catch (error) {
		// ssh2 tags connection failures with `level`; a refused channel has none.
		const err = error as Error & { level?: string };
		if (err.level === "client-authentication") {
			const technicalDetail = `Error: ${err.message} ${err.level}`;
			const friendlyMessage = [
				"",
				"❌ Couldn't connect to your server — the SSH key was not accepted.",
				"",
				"This usually means the key doesn't match what's on the server, or the key format is invalid.",
				"",
				`Technical details: ${technicalDetail}`,
				"",
				"💡 Hints:",
				"  • Check that the SSH key you added in Dokploy is the same one installed on the server (e.g. in ~/.ssh/authorized_keys).",
				"  • Try generating a new SSH key in Dokploy and add only the public key to the server, then try again.",
				"  • Make sure to follow the instructions on the Setup Server Button on the SSH Keys tab and then click on deployments tab and check the logs for more details.",
			].join("\n");
			onData?.(friendlyMessage);
			throw new ExecError(
				`Authentication failed: Invalid SSH private key. ${friendlyMessage}`,
				{ command, serverId, originalError: err },
			);
		}
		const errorMsg = err.level
			? `SSH connection error: ${err.message}`
			: `Remote command execution failed: ${err.message}`;
		onData?.(errorMsg);
		throw new ExecError(errorMsg, { command, serverId, originalError: err });
	}

	let stdout = "";
	let stderr = "";
	return new Promise((resolve, reject) => {
		channel
			.on("close", (code: number) => {
				if (code === 0) {
					resolve({ stdout, stderr });
					return;
				}
				reject(
					new ExecError(`Remote command failed with exit code ${code}`, {
						command,
						stdout,
						stderr,
						exitCode: code,
						serverId,
					}),
				);
			})
			.on("data", (data: Buffer) => {
				stdout += data.toString();
				onData?.(data.toString());
			})
			.stderr.on("data", (data: Buffer) => {
				stderr += data.toString();
				onData?.(data.toString());
			});
		channel.end(command);
	});
};

export const writeFileRemote = async (
	serverId: string,
	remotePath: string,
	content: string,
): Promise<void> => {
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");

	return new Promise((resolve, reject) => {
		const conn = new Client();
		conn
			.once("ready", () => {
				conn.sftp((err, sftp) => {
					if (err) {
						conn.end();
						reject(
							new WriteFileRemoteError(`SFTP session failed: ${err.message}`, {
								remotePath,
								serverId,
								originalError: err,
							}),
						);
						return;
					}
					sftp.writeFile(remotePath, content, (writeErr) => {
						conn.end();
						if (writeErr) {
							reject(
								new WriteFileRemoteError(
									`Failed to write remote file ${remotePath}: ${writeErr.message}`,
									{ remotePath, serverId, originalError: writeErr },
								),
							);
							return;
						}
						resolve();
					});
				});
			})
			.on("error", (err) => {
				conn.end();
				reject(
					new WriteFileRemoteError(`SSH connection error: ${err.message}`, {
						remotePath,
						serverId,
						originalError: err,
					}),
				);
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				timeout: 99999,
			});
	});
};

export const sleep = (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};
