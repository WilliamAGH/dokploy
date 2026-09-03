import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplicationNested, Domain } from "@dokploy/server";
import { manageDomain } from "@dokploy/server";
import { docker } from "@dokploy/server/constants";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_TIMEOUT = 120000;
const suffix = `${process.pid}-${Date.now()}`;
const appName = `dokploy-vip-${suffix}`;
const networkName = `dokploy-vip-${suffix}`;
const proxyName = `dokploy-vip-proxy-${suffix}`;
const dynamicPath = fs.mkdtempSync(path.join(os.tmpdir(), "dokploy-vip-real-"));

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: () => ({
			...actual.paths(),
			DYNAMIC_TRAEFIK_PATH: dynamicPath,
		}),
	};
});

const application = (swarmVipConnectionReuse: boolean): ApplicationNested =>
	({
		appName,
		serverId: null,
		redirects: [],
		security: [],
		swarmVipConnectionReuse,
	}) as unknown as ApplicationNested;

const domain = {
	applicationId: "application-id",
	certificateType: "none",
	createdAt: "",
	domainId: "domain-id",
	host: "127.0.0.1",
	https: false,
	path: null,
	port: 80,
	customEntrypoint: null,
	serviceName: "",
	composeId: null,
	customCertResolver: null,
	domainType: "application",
	uniqueConfigKey: 1,
	previewDeploymentId: null,
	internalPath: "/",
	stripPath: false,
	middlewares: null,
	forwardAuthEnabled: false,
	enabled: true,
} as Domain;

const hasDocker = () => {
	try {
		execSync("docker info", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const pull = async (image: string) => {
	try {
		await docker.getImage(image).inspect();
		return;
	} catch {}
	await new Promise<void>((resolve, reject) =>
		docker.pull(image, (error: Error | null, stream: NodeJS.ReadableStream) =>
			error
				? reject(error)
				: docker.modem.followProgress(stream, (progressError) =>
						progressError ? reject(progressError) : resolve(),
					),
		),
	);
};

const removeContainer = async (name: string) => {
	try {
		await docker.getContainer(name).remove({ force: true });
	} catch {}
};

const cleanup = async () => {
	await removeContainer(proxyName);
	await removeContainer(appName);
	try {
		await docker.getNetwork(networkName).remove();
	} catch {}
};

const backendPort = async (proxyPort: string) => {
	const response = await fetch(`http://127.0.0.1:${proxyPort}`);
	const body = await response.text();
	const match = body.match(/^RemoteAddr: .*:(\d+)$/m);
	if (!match) throw new Error(`whoami response has no RemoteAddr: ${body}`);
	return match[1];
};

const proxyPublishedPort = async () => {
	const inspect = await docker.getContainer(proxyName).inspect();
	const port = inspect.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
	if (!port) throw new Error("Traefik has no published port");
	return port;
};

const waitForProxy = async (proxyPort: string) => {
	const deadline = Date.now() + 10000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await backendPort(proxyPort);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	throw new Error("Traefik did not become ready", { cause: lastError });
};

const waitForConnectionReuse = async (proxyPort: string) => {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const ports = [await backendPort(proxyPort), await backendPort(proxyPort)];
		if (ports[0] === ports[1]) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Traefik did not enable backend connection reuse");
};

describe.skipIf(!process.env.CI || !hasDocker())(
	"Swarm VIP backend connection reuse (real Traefik)",
	() => {
		let proxyPort: string;

		beforeAll(async () => {
			await cleanup();
			await Promise.all([
				pull("traefik:v3.6.25"),
				pull("traefik/whoami:v1.11.0"),
			]);
			await manageDomain(application(false), domain);
			await docker.createNetwork({ Name: networkName });

			const backend = await docker.createContainer({
				name: appName,
				Image: "traefik/whoami:v1.11.0",
				HostConfig: { NetworkMode: networkName },
			});
			await backend.start();

			const proxy = await docker.createContainer({
				name: proxyName,
				Image: "traefik:v3.6.25",
				Cmd: [
					"--entryPoints.web.address=:8080",
					"--providers.file.directory=/etc/traefik/dynamic",
					"--providers.file.watch=true",
				],
				ExposedPorts: { "8080/tcp": {} },
				HostConfig: {
					NetworkMode: networkName,
					Binds: [`${dynamicPath}:/etc/traefik/dynamic:ro`],
					PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1" }] },
				},
			});
			await proxy.start();
			proxyPort = await proxyPublishedPort();

			await waitForProxy(proxyPort);
		}, TEST_TIMEOUT);

		afterAll(async () => {
			await cleanup();
			fs.rmSync(dynamicPath, { recursive: true });
		}, TEST_TIMEOUT);

		test(
			"opens a new backend connection when reuse is disabled",
			async () => {
				const disabledPorts = [
					await backendPort(proxyPort),
					await backendPort(proxyPort),
				];
				expect(disabledPorts[0]).not.toBe(disabledPorts[1]);

				await manageDomain(application(true), domain);
				await waitForConnectionReuse(proxyPort);
			},
			TEST_TIMEOUT,
		);
	},
);
