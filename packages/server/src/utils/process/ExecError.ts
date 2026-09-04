export interface ExecErrorDetails {
	command: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	originalError?: Error;
	serverId?: string | null;
}

const redactDockerLoginPassword = (text: string | undefined) =>
	text?.replace(
		/printf %s '(?:[^']|'\\'')*' \| docker login/g,
		"printf %s '***' | docker login",
	);

export class ExecError extends Error {
	public readonly command: string;
	public readonly stdout?: string;
	public readonly stderr?: string;
	public readonly exitCode?: number;
	public readonly originalError?: Error;
	public readonly serverId?: string | null;

	constructor(message: string, details: ExecErrorDetails) {
		const containsRegistryPassword = details.command.includes("| docker login");
		const redact = containsRegistryPassword
			? redactDockerLoginPassword
			: (text: string | undefined) => text;
		super(redact(message));
		this.name = "ExecError";
		this.command = redact(details.command) ?? "";
		this.stdout = redact(details.stdout);
		this.stderr = redact(details.stderr);
		this.exitCode = details.exitCode;
		this.originalError =
			containsRegistryPassword && details.originalError
				? new Error(redact(details.originalError.message))
				: details.originalError;
		this.serverId = details.serverId;

		// Maintains proper stack trace for where our error was thrown (only available on V8)
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ExecError);
		}
	}

	/**
	 * Get a formatted error message with all details
	 */
	getDetailedMessage(): string {
		const parts = [
			`Command: ${this.command}`,
			this.exitCode !== undefined ? `Exit Code: ${this.exitCode}` : null,
			this.serverId ? `Server ID: ${this.serverId}` : "Location: Local",
			this.stderr ? `Stderr: ${this.stderr}` : null,
			this.stdout ? `Stdout: ${this.stdout}` : null,
		].filter(Boolean);

		return `${this.message}\n${parts.join("\n")}`;
	}

	/**
	 * Check if this error is from a remote execution
	 */
	isRemote(): boolean {
		return !!this.serverId;
	}
}
