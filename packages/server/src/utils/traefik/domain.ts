import type { Domain } from "@dokploy/server/services/domain";
import { resolveServiceNetworks } from "@dokploy/server/services/network";
import {
	assertSwarmReadinessTraefikRuntime,
	isSwarmReadinessTraefikImage,
	readTraefikRuntimeConfig,
} from "@dokploy/server/setup/traefik-setup";
import type { ApplicationNested } from "../builders";
import { createDomainLabels } from "../docker/domain";
import { getRemoteDocker } from "../servers/remote-docker";
import {
	createServiceConfig,
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
	removeTraefikConfig,
	removeTraefikConfigRemote,
	writeTraefikConfig,
	writeTraefikConfigRemote,
} from "./application";
import type { FileConfig, HttpRouter } from "./file-types";
import {
	createForwardAuthMiddleware,
	forwardAuthMiddlewareName,
	removeForwardAuthMiddleware,
} from "./forward-auth";
import { createPathMiddlewares, removePathMiddlewares } from "./middleware";

type ApplicationRouting = Pick<
	ApplicationNested,
	| "appName"
	| "domains"
	| "detachDokployNetwork"
	| "networkIds"
	| "networkSwarm"
	| "readinessCheckSwarm"
	| "redirects"
	| "security"
	| "serverId"
>;

export const usesSwarmReadinessRouting = (
	application: Pick<ApplicationRouting, "readinessCheckSwarm">,
) =>
	process.env.NODE_ENV !== "development" &&
	isSwarmReadinessTraefikImage() &&
	application.readinessCheckSwarm != null;

export const assertSwarmReadinessRouting = async (
	application: Pick<ApplicationRouting, "readinessCheckSwarm" | "serverId">,
	networks: Array<{ Target?: string }>,
) => {
	if (!application.readinessCheckSwarm) {
		return;
	}
	await assertSwarmReadinessTraefikRuntime(application.serverId ?? undefined);
	if (!networks.some((network) => network.Target === "dokploy-network")) {
		throw new Error(
			"Swarm readiness routing requires the dokploy-network ingress network",
		);
	}
};

const ROUTING_CONVERGENCE_ATTEMPTS = 60;
const ROUTING_CONVERGENCE_RETRY_MS = 500;

type SwarmTask = {
	DesiredState?: string;
	NetworksAttachments?: Array<{
		Addresses?: string[];
		Network?: { Spec?: { Name?: string } };
	}>;
	Status?: { State?: string };
};

const expectedSwarmRoutes = (application: ApplicationRouting) =>
	application.domains
		.filter((domain) => domain.enabled && domain.domainType === "application")
		.flatMap((domain) => {
			const serviceId = `${application.appName}-${domain.uniqueConfigKey}@swarm`;
			return [
				domain.customEntrypoint || "web",
				...(!domain.customEntrypoint && domain.https ? ["websecure"] : []),
			].map((entrypoint) => ({
				routerId: `${application.appName}-${domain.uniqueConfigKey}-${entrypoint}@swarm`,
				serviceId,
			}));
		});

const expectedSwarmRouterMiddlewares = (application: ApplicationRouting) => {
	const labels = createApplicationRoutingLabels(application) ?? {};
	return Object.fromEntries(
		Object.entries(labels)
			.filter(([key]) => key.endsWith(".middlewares"))
			.map(([key, value]) => [
				`${key
					.replace(/^traefik\.http\.routers\./, "")
					.replace(/\.middlewares$/, "")}@swarm`,
				value.split(",").map((middleware) => middleware.trim()),
			]),
	);
};

const expectedFileRouterIds = (application: ApplicationRouting) =>
	application.domains
		.filter((domain) => domain.enabled && domain.domainType === "application")
		.flatMap((domain) => [
			`${application.appName}-router-${domain.uniqueConfigKey}`,
			...(!domain.customEntrypoint && domain.https
				? [`${application.appName}-router-websecure-${domain.uniqueConfigKey}`]
				: []),
		]);

const expectedTaskAddresses = async (application: ApplicationRouting) => {
	const docker = await getRemoteDocker(application.serverId);
	const tasks = (await docker.listTasks({
		filters: JSON.stringify({
			service: [application.appName],
			"desired-state": ["running"],
		}),
	})) as SwarmTask[];
	return tasks
		.filter(
			(task) =>
				task.DesiredState === "running" && task.Status?.State === "running",
		)
		.flatMap((task) =>
			(task.NetworksAttachments ?? [])
				.filter(
					(attachment) => attachment.Network?.Spec?.Name === "dokploy-network",
				)
				.flatMap((attachment) => attachment.Addresses ?? [])
				.map((address) => address.split("/", 1)[0])
				.filter((address): address is string => Boolean(address)),
		);
};

const upServerAddresses = (serverStatus: Record<string, string> | undefined) =>
	new Set(
		Object.entries(serverStatus ?? {})
			.filter(([, status]) => status === "UP")
			.map(([server]) => {
				try {
					return new URL(server).hostname.replace(/^\[|\]$/g, "");
				} catch {
					return "";
				}
			}),
	);

const waitForSwarmRouting = async (application: ApplicationRouting) => {
	const routes = expectedSwarmRoutes(application);
	const routerMiddlewares = expectedSwarmRouterMiddlewares(application);
	const serviceIds = [...new Set(routes.map(({ serviceId }) => serviceId))];
	const taskAddresses = await expectedTaskAddresses(application);
	if (routes.length === 0 || taskAddresses.length === 0) {
		throw new Error(
			`Swarm readiness routing for ${application.appName} has no routable tasks`,
		);
	}

	for (let attempt = 0; attempt < ROUTING_CONVERGENCE_ATTEMPTS; attempt += 1) {
		try {
			const runtime = await readTraefikRuntimeConfig(
				application.serverId ?? undefined,
			);
			const routersReady = routes.every(({ routerId, serviceId }) => {
				const router = runtime.routers?.[routerId];
				return (
					router?.status === "enabled" &&
					router.service === serviceId &&
					(router.middlewares ?? []).join(",") ===
						(routerMiddlewares[routerId] ?? []).join(",")
				);
			});
			const servicesReady = serviceIds.every((serviceId) => {
				const service = runtime.services?.[serviceId];
				const admittedAddresses = upServerAddresses(service?.serverStatus);
				return (
					service?.status === "enabled" &&
					taskAddresses.every((address) => admittedAddresses.has(address))
				);
			});
			if (routersReady && servicesReady) {
				return;
			}
		} catch {
			// Provider discovery and the first active probes converge asynchronously.
		}

		await new Promise((resolve) =>
			setTimeout(resolve, ROUTING_CONVERGENCE_RETRY_MS),
		);
	}

	throw new Error(
		`Swarm readiness routing for ${application.appName} did not converge`,
	);
};

const waitForFileRouting = async (application: ApplicationRouting) => {
	const routerIds = expectedFileRouterIds(application).map(
		(routerId) => `${routerId}@file`,
	);
	for (let attempt = 0; attempt < ROUTING_CONVERGENCE_ATTEMPTS; attempt += 1) {
		try {
			const runtime = await readTraefikRuntimeConfig(
				application.serverId ?? undefined,
			);
			if (
				routerIds.length > 0 &&
				routerIds.every(
					(routerId) => runtime.routers?.[routerId]?.status === "enabled",
				)
			) {
				return;
			}
		} catch {
			// The restored file provider route also reloads asynchronously.
		}
		await new Promise((resolve) =>
			setTimeout(resolve, ROUTING_CONVERGENCE_RETRY_MS),
		);
	}
	throw new Error(`File routing for ${application.appName} did not recover`);
};

const expectedFileMiddlewareIds = (application: ApplicationRouting) =>
	Object.entries(createApplicationRoutingLabels(application) ?? {})
		.filter(([key]) => key.endsWith(".middlewares"))
		.flatMap(([, value]) => value.split(","))
		.map((middleware) => middleware.trim())
		.filter((middleware) => middleware.endsWith("@file"));

const waitForFileMiddlewares = async (application: ApplicationRouting) => {
	const middlewareIds = expectedFileMiddlewareIds(application);
	if (middlewareIds.length === 0) {
		return;
	}
	for (let attempt = 0; attempt < ROUTING_CONVERGENCE_ATTEMPTS; attempt += 1) {
		try {
			const runtime = await readTraefikRuntimeConfig(
				application.serverId ?? undefined,
			);
			if (
				middlewareIds.every(
					(middlewareId) =>
						runtime.middlewares?.[middlewareId]?.status === "enabled",
				)
			) {
				return;
			}
		} catch {
			// File-provider middleware updates converge asynchronously.
		}
		await new Promise((resolve) =>
			setTimeout(resolve, ROUTING_CONVERGENCE_RETRY_MS),
		);
	}
	throw new Error(
		`File middlewares for ${application.appName} did not converge`,
	);
};

const toLabelRecord = (labels: string[]) =>
	Object.fromEntries(
		labels.map((label) => {
			const separator = label.indexOf("=");
			return [label.slice(0, separator), label.slice(separator + 1)];
		}),
	);

export const createApplicationRoutingLabels = (
	application: ApplicationRouting,
	preferFileRouting = false,
) => {
	if (!usesSwarmReadinessRouting(application)) {
		return undefined;
	}

	const { appName, readinessCheckSwarm } = application;
	if (!readinessCheckSwarm) {
		return undefined;
	}

	const labels: Record<string, string> = {
		"traefik.enable": "true",
		"traefik.swarm.network": "dokploy-network",
		"traefik.swarm.lbswarm": "false",
	};

	for (const domain of application.domains.filter(
		(domain) => domain.enabled && domain.domainType === "application",
	)) {
		const fileMiddlewares = [
			...application.redirects.map(
				(redirect) => `redirect-${appName}-${redirect.uniqueConfigKey}@file`,
			),
			...(application.security.length > 0 ? [`auth-${appName}@file`] : []),
			...(domain.forwardAuthEnabled
				? [
						`${forwardAuthMiddlewareName(appName, domain.uniqueConfigKey)}-errors@file`,
						`${forwardAuthMiddlewareName(appName, domain.uniqueConfigKey)}@file`,
					]
				: []),
		];
		const routedDomain = {
			...domain,
			middlewares: [...fileMiddlewares, ...(domain.middlewares ?? [])],
		};
		const entrypoints = [
			domain.customEntrypoint || "web",
			...(!domain.customEntrypoint && domain.https ? ["websecure"] : []),
		];
		const serviceName = `${appName}-${domain.uniqueConfigKey}`;

		for (const entrypoint of entrypoints) {
			const domainLabels = toLabelRecord(
				createDomainLabels(appName, routedDomain, entrypoint),
			);
			for (const [key, value] of Object.entries(domainLabels)) {
				if (key.endsWith(".loadbalancer.server.port")) {
					continue;
				}
				labels[key] = key.endsWith(".service") ? `${serviceName}@swarm` : value;
				if (preferFileRouting && key.endsWith(".rule")) {
					labels[key.replace(/\.rule$/, ".priority")] = String(
						Math.max(1, value.length - 1),
					);
				}
			}
		}

		const healthCheck = `traefik.http.services.${serviceName}.loadbalancer.healthcheck`;
		labels[`traefik.http.services.${serviceName}.loadbalancer.server.port`] =
			String(domain.port || 80);
		labels[`${healthCheck}.path`] = readinessCheckSwarm.Path;
		labels[`${healthCheck}.interval`] = `${readinessCheckSwarm.Interval}ns`;
		labels[`${healthCheck}.unhealthyinterval`] =
			`${readinessCheckSwarm.UnhealthyInterval}ns`;
		labels[`${healthCheck}.timeout`] = `${readinessCheckSwarm.Timeout}ns`;
		labels[`${healthCheck}.status`] = String(readinessCheckSwarm.Status);
		labels[`${healthCheck}.initialstatus`] = "down";
	}

	return labels;
};

const isApplicationRoutingLabel = (appName: string, key: string) =>
	key === "traefik.enable" ||
	key === "traefik.swarm.network" ||
	key === "traefik.swarm.lbswarm" ||
	key.startsWith(`traefik.http.routers.${appName}-`) ||
	key.startsWith(`traefik.http.services.${appName}-`) ||
	key.startsWith(`traefik.http.middlewares.stripprefix-${appName}-`) ||
	key.startsWith(`traefik.http.middlewares.addprefix-${appName}-`);

export const syncApplicationRoutingLabels = async (
	application: ApplicationRouting,
	routingLabels = createApplicationRoutingLabels(application),
) => {
	const docker = await getRemoteDocker(application.serverId);
	const service = docker.getService(application.appName);
	let inspect: Awaited<ReturnType<typeof service.inspect>>;
	try {
		inspect = await service.inspect();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode === 404) {
			return false;
		}
		throw error;
	}

	if (!inspect.Spec || inspect.Version?.Index === undefined) {
		throw new Error(`Unable to inspect service ${application.appName}`);
	}

	const existingLabels = Object.fromEntries(
		Object.entries(inspect.Spec.Labels ?? {}).filter(
			([key]) => !isApplicationRoutingLabel(application.appName, key),
		),
	);
	await service.update({
		version: Number(inspect.Version.Index),
		...inspect.Spec,
		Labels: {
			...existingLabels,
			...routingLabels,
		},
	});
	return true;
};

const activateSwarmReadinessRouting = async (
	application: ApplicationRouting,
) => {
	const networks = await resolveServiceNetworks(application);
	await assertSwarmReadinessRouting(application, networks);
	const legacyConfig = application.serverId
		? await loadOrCreateConfigRemote(application.serverId, application.appName)
		: loadOrCreateConfig(application.appName);
	const legacyRouterIds = expectedFileRouterIds(application);
	if (legacyRouterIds.length === 0) {
		await syncApplicationRoutingLabels({
			...application,
			readinessCheckSwarm: null,
		});
		await removeTraefikConfig(application.appName, application.serverId);
		return;
	}
	const hasLegacyRoute =
		legacyRouterIds.length > 0 &&
		legacyRouterIds.every((routerId) => legacyConfig.http?.routers?.[routerId]);
	await waitForFileMiddlewares(application);
	if (
		!(await syncApplicationRoutingLabels(
			application,
			createApplicationRoutingLabels(application, hasLegacyRoute),
		))
	) {
		throw new Error(
			`Cannot activate Swarm readiness routing before ${application.appName} is deployed`,
		);
	}
	try {
		await waitForSwarmRouting(application);
		if (hasLegacyRoute) {
			await removeTraefikConfig(application.appName, application.serverId);
			await syncApplicationRoutingLabels(application);
			await waitForSwarmRouting(application);
		}
	} catch (error) {
		if (!hasLegacyRoute) {
			throw error;
		}
		const recoveryErrors: unknown[] = [];
		try {
			if (application.serverId) {
				await writeTraefikConfigRemote(
					legacyConfig,
					application.appName,
					application.serverId,
				);
			} else {
				writeTraefikConfig(legacyConfig, application.appName);
			}
			await waitForFileRouting(application);
		} catch (recoveryError) {
			recoveryErrors.push(recoveryError);
		}
		try {
			await syncApplicationRoutingLabels({
				...application,
				readinessCheckSwarm: null,
			});
		} catch (recoveryError) {
			recoveryErrors.push(recoveryError);
		}
		if (recoveryErrors.length > 0) {
			throw new AggregateError(
				[error, ...recoveryErrors],
				"Swarm routing activation and recovery failed",
			);
		}
		throw error;
	}
};

export const synchronizeApplicationRouting = async (
	application: ApplicationNested,
) => {
	if (application.readinessCheckSwarm) {
		for (const domain of application.domains) {
			if (domain.enabled && domain.forwardAuthEnabled) {
				await createForwardAuthMiddleware(application, domain);
			}
		}
		await activateSwarmReadinessRouting(application);
		for (const domain of application.domains) {
			await removePathMiddlewares(application, domain.uniqueConfigKey);
		}
		return;
	}

	for (const domain of application.domains) {
		await manageDomain(application, domain);
	}
	if (expectedFileRouterIds(application).length > 0) {
		await waitForFileRouting(application);
	}
	await syncApplicationRoutingLabels(application);
};

export const manageDomain = async (app: ApplicationNested, domain: Domain) => {
	const { appName } = app;
	if (domain.domainType === "application" && app.readinessCheckSwarm) {
		if (domain.enabled && domain.forwardAuthEnabled) {
			await createForwardAuthMiddleware(app, domain);
		}
		await activateSwarmReadinessRouting({
			...app,
			domains: [
				...app.domains.filter(({ domainId }) => domainId !== domain.domainId),
				domain,
			],
		});
		await removePathMiddlewares(app, domain.uniqueConfigKey);
		if (!domain.enabled || !domain.forwardAuthEnabled) {
			await removeForwardAuthMiddleware(app, domain.uniqueConfigKey);
		}
		return;
	}

	// A disabled domain keeps its configuration in the database but must never
	// expose a traefik router. Guarding here covers every caller (create, update,
	// forward-auth, toggle) so a disabled domain can't be revived from any path.
	if (!domain.enabled) {
		await removeDomain(app, domain.uniqueConfigKey);
		return;
	}

	let config: FileConfig;

	if (app.serverId) {
		config = await loadOrCreateConfigRemote(app.serverId, appName);
	} else {
		config = loadOrCreateConfig(appName);
	}
	const serviceName = `${appName}-service-${domain.uniqueConfigKey}`;
	const routerName = `${appName}-router-${domain.uniqueConfigKey}`;
	const routerNameSecure = `${appName}-router-websecure-${domain.uniqueConfigKey}`;

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	config.http.routers[routerName] = await createRouterConfig(
		app,
		domain,
		domain.customEntrypoint || "web",
	);

	if (!domain.customEntrypoint && domain.https) {
		config.http.routers[routerNameSecure] = await createRouterConfig(
			app,
			domain,
			"websecure",
		);
	} else {
		delete config.http.routers[routerNameSecure];
	}

	config.http.services[serviceName] = createServiceConfig(appName, domain);

	await createPathMiddlewares(app, domain);
	// SSO forward-auth: writes the per-app forwardAuth + errors middlewares (the
	// /oauth2/* router lives on the central auth domain, not here). No-op unless
	// the domain links a provider and the org has an auth domain configured.
	await createForwardAuthMiddleware(app, domain);

	if (app.serverId) {
		await writeTraefikConfigRemote(config, appName, app.serverId);
	} else {
		writeTraefikConfig(config, appName);
	}
};

export const removeDomain = async (
	application: ApplicationNested,
	uniqueKey: number,
) => {
	if (application.readinessCheckSwarm) {
		await activateSwarmReadinessRouting(application);
		await removePathMiddlewares(application, uniqueKey);
		await removeForwardAuthMiddleware(application, uniqueKey);
		return;
	}
	const { appName, serverId } = application;
	let config: FileConfig;

	if (serverId) {
		config = await loadOrCreateConfigRemote(serverId, appName);
	} else {
		config = loadOrCreateConfig(appName);
	}

	const routerKey = `${appName}-router-${uniqueKey}`;
	const routerSecureKey = `${appName}-router-websecure-${uniqueKey}`;

	const serviceKey = `${appName}-service-${uniqueKey}`;
	if (config.http?.routers?.[routerKey]) {
		delete config.http.routers[routerKey];
	}
	if (config.http?.routers?.[routerSecureKey]) {
		delete config.http.routers[routerSecureKey];
	}
	if (config.http?.services?.[serviceKey]) {
		delete config.http.services[serviceKey];
	}

	await removePathMiddlewares(application, uniqueKey);
	await removeForwardAuthMiddleware(application, uniqueKey);

	// verify if is the last router if so we delete the router
	if (
		config?.http?.routers &&
		Object.keys(config?.http?.routers).length === 0
	) {
		if (serverId) {
			await removeTraefikConfigRemote(appName, serverId);
		} else {
			await removeTraefikConfig(appName);
		}
	} else {
		if (serverId) {
			await writeTraefikConfigRemote(config, appName, serverId);
		} else {
			writeTraefikConfig(config, appName);
		}
	}
};

/**
 * Converts an internationalized domain name (IDN) to ASCII punycode format.
 * Traefik requires domain names in ASCII format, so non-ASCII characters
 * must be converted (e.g., "тест.рф" → "xn--e1aybc.xn--p1ai").
 */
const toPunycode = (host: string): string => {
	try {
		return new URL(`http://${host}`).hostname;
	} catch {
		// If URL parsing fails, return the original host
		return host;
	}
};

export const createRouterConfig = async (
	app: ApplicationNested,
	domain: Domain,
	entryPoint: string,
) => {
	const { appName, redirects, security } = app;
	const { certificateType } = domain;

	const {
		host,
		path,
		https,
		uniqueConfigKey,
		internalPath,
		stripPath,
		customEntrypoint,
	} = domain;
	const punycodeHost = toPunycode(host);
	const routerConfig: HttpRouter = {
		rule: `Host(\`${punycodeHost}\`)${path !== null && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		service: `${appName}-service-${uniqueConfigKey}`,
		middlewares: [],
		entryPoints: [entryPoint],
	};

	const isRedirectRouter = entryPoint === "web" && https && !customEntrypoint;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		routerConfig.middlewares?.push("redirect-to-https");
	} else {
		// Add path rewriting middleware if needed
		// stripPrefix must come before addPrefix so Traefik strips the
		// public path first, then prepends the internal path.
		if (stripPath && path && path !== "/") {
			const stripMiddleware = `stripprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(stripMiddleware);
		}

		if (internalPath && internalPath !== "/" && internalPath !== path) {
			const pathMiddleware = `addprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(pathMiddleware);
		}

		// redirects - skip for preview deployments as wildcard subdomains
		// should not inherit parent redirect rules (e.g., www-redirect)
		if (domain.domainType !== "preview") {
			for (const redirect of redirects) {
				const middlewareName = `redirect-${appName}-${redirect.uniqueConfigKey}`;
				routerConfig.middlewares?.push(middlewareName);
			}
		}

		// security
		if (security.length > 0) {
			let middlewareName = `auth-${appName}`;
			if (domain.domainType === "preview") {
				middlewareName = `auth-${appName.replace(
					/^preview-(.+)-[^-]+$/,
					"$1",
				)}`;
			}
			routerConfig.middlewares?.push(middlewareName);
		}

		// Enterprise SSO forward-auth gate. Placed before custom middlewares so
		// authentication runs first. No-op unless the domain links a provider.
		// The -errors middleware must come first so a 401 from the auth check is
		// rewritten to a 302 redirect to the login page.
		if (domain.forwardAuthEnabled) {
			const name = forwardAuthMiddlewareName(appName, uniqueConfigKey);
			routerConfig.middlewares?.push(`${name}-errors`);
			routerConfig.middlewares?.push(name);
		}

		// custom middlewares from domain
		if (domain.middlewares && domain.middlewares.length > 0) {
			routerConfig.middlewares?.push(...domain.middlewares);
		}
	}

	if (entryPoint === "websecure" || (customEntrypoint && https)) {
		if (certificateType === "letsencrypt") {
			routerConfig.tls = { certResolver: "letsencrypt" };
		} else if (certificateType === "custom" && domain.customCertResolver) {
			routerConfig.tls = { certResolver: domain.customCertResolver };
		} else if (certificateType === "none") {
			routerConfig.tls = undefined;
		}
	}

	return routerConfig;
};
