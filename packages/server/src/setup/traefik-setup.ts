import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
	ContainerCreateOptions,
	ContainerInspectInfo,
	CreateServiceOptions,
} from "dockerode";
import { stringify } from "yaml";
import { paths } from "../constants";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import type { FileConfig } from "../utils/traefik/file-types";
import type { MainTraefikConfig } from "../utils/traefik/types";

export const TRAEFIK_SSL_PORT =
	Number.parseInt(process.env.TRAEFIK_SSL_PORT!, 10) || 443;
export const TRAEFIK_PORT =
	Number.parseInt(process.env.TRAEFIK_PORT!, 10) || 80;
export const TRAEFIK_HTTP3_PORT =
	Number.parseInt(process.env.TRAEFIK_HTTP3_PORT!, 10) || 443;
export const TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || "3.6.25";
export const TRAEFIK_IMAGE =
	process.env.TRAEFIK_IMAGE || `traefik:v${TRAEFIK_VERSION}`;

// Fail closed until the reviewed v3.6.25 image is published and this one
// code-owned reference is replaced with its immutable digest.
export const SWARM_READINESS_TRAEFIK_IMAGE =
	"ghcr.io/williamagh/traefik@sha256:445ede9f30d3fe0c1afb41523b0819059a44b5fc3e769b29f6057705ef2ab694";

export const isSwarmReadinessTraefikImage = (
	image = process.env.TRAEFIK_IMAGE,
) => image === SWARM_READINESS_TRAEFIK_IMAGE;

type DockerClient = Awaited<ReturnType<typeof getRemoteDocker>>;
type DockerContainer = ReturnType<DockerClient["getContainer"]>;

const TRAEFIK_CONTAINER_NAME = "dokploy-traefik";
const TRAEFIK_API_ATTEMPTS = 20;
const TRAEFIK_API_RETRY_MS = 500;

const isNotFound = (error: unknown) =>
	(error as { statusCode?: number }).statusCode === 404;

const pullTraefikImage = async (docker: DockerClient, image: string) => {
	await new Promise<void>((resolve, reject) => {
		docker.pull(image, {}, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}
			docker.modem.followProgress(
				stream as Readable,
				(progressError: Error | null) => {
					if (progressError) {
						reject(progressError);
						return;
					}
					resolve();
				},
			);
		});
	});
};

const readExec = async (stream: Readable) => {
	return await new Promise<string>((resolve, reject) => {
		let output = "";
		stream.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
		stream.resume();
	});
};

export interface TraefikRuntimeConfig {
	middlewares?: Record<string, { status?: string }>;
	routers?: Record<
		string,
		{ middlewares?: string[]; service?: string; status?: string }
	>;
	services?: Record<
		string,
		{ serverStatus?: Record<string, string>; status?: string }
	>;
}

interface TraefikOverview {
	providers?: string[];
}

const readTraefikApi = async <T>(container: DockerContainer, path: string) => {
	const command = await container.exec({
		Cmd: ["wget", "-q", "-T", "1", "-O", "-", `http://127.0.0.1:8080${path}`],
		AttachStdout: true,
		AttachStderr: true,
		Tty: true,
	});
	const output = await readExec((await command.start({})) as Readable);
	if ((await command.inspect()).ExitCode !== 0) {
		throw new Error("Traefik API request failed");
	}
	return JSON.parse(output) as T;
};

const readTraefikRuntime = async (container: DockerContainer) =>
	await readTraefikApi<TraefikRuntimeConfig>(container, "/api/rawdata");

const waitForTraefikApi = async (container: DockerContainer) => {
	for (let attempt = 0; attempt < TRAEFIK_API_ATTEMPTS; attempt += 1) {
		const state = (await container.inspect()).State;
		if (!state.Running && !state.Restarting) {
			throw new Error(
				`Traefik stopped before its API became ready: ${state.Error}`,
			);
		}

		try {
			const overview = await readTraefikApi<TraefikOverview>(
				container,
				"/api/overview",
			);
			if (
				["Swarm", "Docker", "File"].every((provider) =>
					overview.providers?.includes(provider),
				)
			) {
				return;
			}
		} catch {
			// The API is expected to refuse connections briefly during startup.
		}

		await new Promise((resolve) => setTimeout(resolve, TRAEFIK_API_RETRY_MS));
	}

	throw new Error("Traefik API did not become ready");
};

export const readTraefikRuntimeConfig = async (serverId?: string) =>
	await readTraefikRuntime(
		(await getRemoteDocker(serverId)).getContainer(TRAEFIK_CONTAINER_NAME),
	);

export const assertSwarmReadinessTraefikRuntime = async (serverId?: string) => {
	if (
		process.env.NODE_ENV === "development" ||
		!isSwarmReadinessTraefikImage()
	) {
		throw new Error(
			"Swarm readiness routing requires the supported immutable Traefik image",
		);
	}

	const inspect = await (await getRemoteDocker(serverId))
		.getContainer(TRAEFIK_CONTAINER_NAME)
		.inspect();
	if (
		!inspect.State.Running ||
		inspect.Config.Image !== SWARM_READINESS_TRAEFIK_IMAGE
	) {
		throw new Error(
			"Swarm readiness routing requires the supported Traefik image to be running",
		);
	}
};

type AccessLogOutput = Pick<
	NonNullable<MainTraefikConfig["accessLog"]>,
	"bufferingSize" | "filePath"
>;

export const getDefaultAccessLogConfig = (output: AccessLogOutput = {}) => ({
	...output,
	format: "json",
	fields: {
		headers: {
			defaultMode: "drop",
		},
		queryParameters: {
			defaultMode: "drop",
		},
	},
});

export interface TraefikOptions {
	env?: string[];
	serverId?: string;
	additionalPorts?: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[];
}

const reconcileStandaloneTraefik = async ({
	env,
	serverId,
	additionalPorts,
}: TraefikOptions = {}) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = TRAEFIK_IMAGE;
	const docker = await getRemoteDocker(serverId);
	let currentContainer = docker.getContainer(TRAEFIK_CONTAINER_NAME);
	let currentInspect: ContainerInspectInfo | undefined;
	try {
		currentInspect = await currentContainer.inspect();
		currentContainer = docker.getContainer(currentInspect.Id);
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}

	const candidateName = `${TRAEFIK_CONTAINER_NAME}-candidate-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const currentPortBindings = (currentInspect?.HostConfig.PortBindings ??
		{}) as Record<string, Array<{ HostPort: string }> | null>;
	const desiredAdditionalPorts =
		additionalPorts ??
		Object.entries(currentPortBindings).flatMap(([portKey, bindings]) => {
			const [targetPortText, protocol = "tcp"] = portKey.split("/");
			const targetPort = Number.parseInt(targetPortText ?? "", 10);
			const isDefaultPort =
				(targetPort === TRAEFIK_PORT && protocol === "tcp") ||
				(targetPort === TRAEFIK_SSL_PORT && protocol === "tcp") ||
				(targetPort === TRAEFIK_HTTP3_PORT && protocol === "udp");
			if (Number.isNaN(targetPort) || isDefaultPort) {
				return [];
			}
			return (bindings ?? []).map((binding) => ({
				targetPort,
				publishedPort: Number.parseInt(binding.HostPort, 10),
				protocol,
			}));
		});

	const exposedPorts: Record<string, {}> = {
		[`${TRAEFIK_PORT}/tcp`]: {},
		[`${TRAEFIK_SSL_PORT}/tcp`]: {},
		[`${TRAEFIK_HTTP3_PORT}/udp`]: {},
	};

	const portBindings: Record<string, Array<{ HostPort: string }>> = {
		[`${TRAEFIK_PORT}/tcp`]: [{ HostPort: TRAEFIK_PORT.toString() }],
		[`${TRAEFIK_SSL_PORT}/tcp`]: [{ HostPort: TRAEFIK_SSL_PORT.toString() }],
		[`${TRAEFIK_HTTP3_PORT}/udp`]: [
			{ HostPort: TRAEFIK_HTTP3_PORT.toString() },
		],
	};

	const enableDashboard = desiredAdditionalPorts.some(
		(port) => port.targetPort === 8080,
	);

	if (enableDashboard) {
		exposedPorts["8080/tcp"] = {};
		portBindings["8080/tcp"] = [{ HostPort: "8080" }];
	}

	for (const port of desiredAdditionalPorts) {
		const portKey = `${port.targetPort}/${port.protocol ?? "tcp"}`;
		exposedPorts[portKey] = {};
		portBindings[portKey] = [{ HostPort: port.publishedPort.toString() }];
	}

	const settings: ContainerCreateOptions = {
		name: candidateName,
		Image: imageName,
		NetworkingConfig: {
			EndpointsConfig: Object.fromEntries(
				[
					"dokploy-network",
					...Object.keys(currentInspect?.NetworkSettings.Networks ?? {}),
				].map((network) => [network, {}]),
			),
		},
		ExposedPorts: exposedPorts,
		HostConfig: {
			RestartPolicy: {
				Name: "always",
			},
			Binds: [
				`${MAIN_TRAEFIK_PATH}/traefik.yml:/etc/traefik/traefik.yml`,
				`${DYNAMIC_TRAEFIK_PATH}:/etc/dokploy/traefik/dynamic`,
				"/var/run/docker.sock:/var/run/docker.sock",
			],
			PortBindings: portBindings,
		},
		Env: env ?? currentInspect?.Config.Env,
	};

	await pullTraefikImage(docker, imageName);
	const candidate = await docker.createContainer(settings);
	const currentWasRunning = Boolean(
		currentInspect?.State.Running || currentInspect?.State.Restarting,
	);
	let currentRenamed = false;
	try {
		if (currentInspect) {
			if (currentWasRunning) {
				await currentContainer.stop();
			}
			await currentContainer.rename({
				name: `${TRAEFIK_CONTAINER_NAME}-rollback-${currentInspect.Id.slice(0, 12)}`,
			});
			currentRenamed = true;
		}

		await candidate.rename({ name: TRAEFIK_CONTAINER_NAME });
		await candidate.start();
		await waitForTraefikApi(candidate);
		console.log("Traefik Started ✅");
	} catch (error) {
		const recoveryErrors: unknown[] = [];
		try {
			await candidate.remove({ force: true });
		} catch (recoveryError) {
			if (!isNotFound(recoveryError)) {
				recoveryErrors.push(recoveryError);
			}
		}

		if (currentInspect) {
			try {
				if (currentRenamed) {
					await currentContainer.rename({ name: TRAEFIK_CONTAINER_NAME });
				}
				if (currentWasRunning) {
					await currentContainer.start();
					await waitForTraefikApi(currentContainer);
				}
			} catch (recoveryError) {
				recoveryErrors.push(recoveryError);
			}
		}

		if (recoveryErrors.length > 0) {
			throw new AggregateError(
				[error, ...recoveryErrors],
				"Traefik reconciliation and automatic restoration failed",
			);
		}
		throw error;
	}
};

const standaloneTraefikReconciliations = new Map<string, Promise<void>>();

export const initializeStandaloneTraefik = (
	options: TraefikOptions = {},
): Promise<void> => {
	const target = options.serverId ?? "local";
	const previous = standaloneTraefikReconciliations.get(target);
	const reconciliation = (previous ?? Promise.resolve())
		.catch(() => undefined)
		.then(() => reconcileStandaloneTraefik(options));
	standaloneTraefikReconciliations.set(target, reconciliation);
	return reconciliation.finally(() => {
		if (standaloneTraefikReconciliations.get(target) === reconciliation) {
			standaloneTraefikReconciliations.delete(target);
		}
	});
};

export const initializeTraefikService = async ({
	env,
	additionalPorts = [],
	serverId,
}: TraefikOptions) => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths(!!serverId);
	const imageName = TRAEFIK_IMAGE;
	const appName = "dokploy-traefik";

	const settings: CreateServiceOptions = {
		Name: appName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: env,
				Mounts: [
					{
						Type: "bind",
						Source: `${MAIN_TRAEFIK_PATH}/traefik.yml`,
						Target: "/etc/traefik/traefik.yml",
					},
					{
						Type: "bind",
						Source: DYNAMIC_TRAEFIK_PATH,
						Target: "/etc/dokploy/traefik/dynamic",
					},
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
					},
				],
			},
			Networks: [{ Target: "dokploy-network" }],
			Placement: {
				Constraints: ["node.role==manager"],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
		EndpointSpec: {
			Ports: [
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},
				{
					TargetPort: 443,
					PublishedPort: TRAEFIK_SSL_PORT,
					PublishMode: "host",
					Protocol: "udp",
				},
				{
					TargetPort: 80,
					PublishedPort: TRAEFIK_PORT,
					PublishMode: "host",
					Protocol: "tcp",
				},

				...additionalPorts.map((port) => ({
					TargetPort: port.targetPort,
					PublishedPort: port.publishedPort,
					Protocol: port.protocol as "tcp" | "udp" | "sctp" | undefined,
					PublishMode: "host" as const,
				})),
			],
		},
	};
	const docker = await getRemoteDocker(serverId);
	try {
		const service = docker.getService(appName);
		const inspect = await service.inspect();

		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: inspect.Spec.TaskTemplate.ForceUpdate + 1,
			},
		});
		console.log("Traefik Updated ✅");
	} catch {
		await docker.createService(settings);
		console.log("Traefik Started ✅");
	}
};

export const createDefaultServerTraefikConfig = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const configFilePath = path.join(DYNAMIC_TRAEFIK_PATH, "dokploy.yml");

	if (existsSync(configFilePath)) {
		console.log("Default traefik config already exists");
		return;
	}

	const appName = "dokploy";
	const serviceURLDefault = `http://${appName}:${process.env.PORT || 3000}`;
	const config: FileConfig = {
		http: {
			routers: {
				[`${appName}-router-app`]: {
					rule: `Host(\`${appName}.docker.localhost\`) && PathPrefix(\`/\`)`,
					service: `${appName}-service-app`,
					entryPoints: ["web"],
				},
			},
			services: {
				[`${appName}-service-app`]: {
					loadBalancer: {
						servers: [{ url: serviceURLDefault }],
						passHostHeader: true,
					},
				},
			},
		},
	};

	const yamlStr = stringify(config);
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(
		path.join(DYNAMIC_TRAEFIK_PATH, `${appName}.yml`),
		yamlStr,
		"utf8",
	);
};

export const getDefaultTraefikConfig = () => {
	const configObject: MainTraefikConfig = {
		global: {
			sendAnonymousUsage: false,
		},
		accessLog: getDefaultAccessLogConfig(),
		providers: {
			...(process.env.NODE_ENV === "development"
				? {
						docker: {
							defaultRule:
								"Host(`{{ trimPrefix `/` .Name }}.docker.localhost`)",
						},
					}
				: {
						swarm: {
							exposedByDefault: false,
							watch: true,
						},
						docker: {
							exposedByDefault: false,
							watch: true,
							network: "dokploy-network",
						},
					}),
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				...(process.env.NODE_ENV === "production" && {
					http: {
						tls: {
							certResolver: "letsencrypt",
						},
					},
				}),
			},
		},
		api: {
			insecure: true,
		},
		...(process.env.NODE_ENV === "production" && {
			certificatesResolvers: {
				letsencrypt: {
					acme: {
						email: "test@localhost.com",
						storage: "/etc/dokploy/traefik/dynamic/acme.json",
						httpChallenge: {
							entryPoint: "web",
						},
					},
				},
			},
		}),
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const getDefaultServerTraefikConfig = () => {
	const configObject: MainTraefikConfig = {
		accessLog: getDefaultAccessLogConfig(),
		providers: {
			swarm: {
				exposedByDefault: false,
				watch: true,
			},
			docker: {
				exposedByDefault: false,
				watch: true,
				network: "dokploy-network",
			},
			file: {
				directory: "/etc/dokploy/traefik/dynamic",
				watch: true,
			},
		},
		entryPoints: {
			web: {
				address: `:${TRAEFIK_PORT}`,
			},
			websecure: {
				address: `:${TRAEFIK_SSL_PORT}`,
				http3: {
					advertisedPort: TRAEFIK_HTTP3_PORT,
				},
				http: {
					tls: {
						certResolver: "letsencrypt",
					},
				},
			},
		},
		api: {
			insecure: true,
		},
		certificatesResolvers: {
			letsencrypt: {
				acme: {
					email: "test@localhost.com",
					storage: "/etc/dokploy/traefik/dynamic/acme.json",
					httpChallenge: {
						entryPoint: "web",
					},
				},
			},
		},
	};

	const yamlStr = stringify(configObject);

	return yamlStr;
};

export const createDefaultTraefikConfig = () => {
	const { MAIN_TRAEFIK_PATH, DYNAMIC_TRAEFIK_PATH } = paths();
	const mainConfig = path.join(MAIN_TRAEFIK_PATH, "traefik.yml");
	const acmeJsonPath = path.join(DYNAMIC_TRAEFIK_PATH, "acme.json");

	if (existsSync(acmeJsonPath)) {
		chmodSync(acmeJsonPath, "600");
	}

	// Create the traefik directory first
	mkdirSync(MAIN_TRAEFIK_PATH, { recursive: true });

	// Check if traefik.yml exists and handle the case where it might be a directory
	if (existsSync(mainConfig)) {
		const stats = statSync(mainConfig);
		if (stats.isDirectory()) {
			// If traefik.yml is a directory, remove it
			console.log("Found traefik.yml as directory, removing it...");
			rmSync(mainConfig, { recursive: true, force: true });
		} else if (stats.isFile()) {
			console.log("Main config already exists");
			return;
		}
	}

	const yamlStr = getDefaultTraefikConfig();
	writeFileSync(mainConfig, yamlStr, "utf8");
	console.log("Traefik config created successfully");
};

export const getDefaultMiddlewares = () => {
	const defaultMiddlewares = {
		http: {
			middlewares: {
				"redirect-to-https": {
					redirectScheme: {
						scheme: "https",
						permanent: true,
					},
				},
			},
		},
	};
	const yamlStr = stringify(defaultMiddlewares);
	return yamlStr;
};
export const createDefaultMiddlewares = () => {
	const { DYNAMIC_TRAEFIK_PATH } = paths();
	const middlewaresPath = path.join(DYNAMIC_TRAEFIK_PATH, "middlewares.yml");
	if (existsSync(middlewaresPath)) {
		console.log("Default middlewares already exists");
		return;
	}
	const yamlStr = getDefaultMiddlewares();
	mkdirSync(DYNAMIC_TRAEFIK_PATH, { recursive: true });
	writeFileSync(middlewaresPath, yamlStr, "utf8");
};
