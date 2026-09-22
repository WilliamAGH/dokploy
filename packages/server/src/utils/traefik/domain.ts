import type { Domain } from "@dokploy/server/services/domain";
import { TRPCError } from "@trpc/server";
import type { ApplicationNested } from "../builders";
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

/**
 * Every server whose Traefik publishes this application's routes: the one it runs
 * on, plus each `ingressServerIds` entry. Each target is the application seen from
 * that server, so every writer below keeps working unchanged — the file, its
 * middlewares and its routers are per server.
 */
export const ingressTargets = (app: ApplicationNested): ApplicationNested[] => {
	const extra = [...new Set(app.ingressServerIds ?? [])].filter(
		(serverId) => serverId && serverId !== app.serverId,
	);
	// The view of one server carries no ingress list of its own. Without this,
	// removeDomain(view of A) would expand targets again and take B's routes with
	// it.
	return [
		app,
		...extra.map((serverId) => ({ ...app, serverId, ingressServerIds: [] })),
	];
};

/**
 * Refuses the two combinations multiple ingress servers cannot serve correctly,
 * rather than rendering something that silently fails. Checking here covers every
 * caller: domain create, update, enable, forward-auth, and an application update
 * that adds an ingress server.
 *
 * The built-in `letsencrypt` resolver. Dokploy's setup configures it as an
 * HTTP-01 challenge, and Traefik is explicit that several instances cannot share
 * that: nothing routes a challenge to the instance that started it
 * (certificate-resolvers/acme.md). Under round-robin DNS the challenge for ANY of
 * them lands on whichever instance DNS picked. A DNS-01 resolver answers through
 * the zone instead, so each instance issues and renews on its own: use one as a
 * `custom` resolver, or install a certificate on each server.
 *
 * Basic auth or redirects. Their middlewares are written only to the server the
 * application runs on, and Traefik fails a router whose middleware is missing
 * rather than skipping it. The security writer also appends a freshly hashed user
 * on every call, so it cannot simply be replayed on each ingress server.
 */
const assertMultiIngressSupported = (
	app: ApplicationNested,
	domain: Domain,
	targetCount: number,
) => {
	if (targetCount < 2) {
		return;
	}
	if (domain.certificateType === "letsencrypt") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Domain ${domain.host} uses the HTTP-01 "letsencrypt" resolver, which cannot be shared by the ${targetCount} Traefik instances serving this application. Use a DNS-01 resolver (certificate type custom), or install a certificate on each ingress server and set the certificate type to none.`,
		});
	}
	if (app.security.length > 0 || app.redirects.length > 0) {
		throw ingressMiddlewareUnsupported(app);
	}
};

const ingressMiddlewareUnsupported = (app: ApplicationNested) =>
	new TRPCError({
		code: "BAD_REQUEST",
		message: `Application ${app.appName} has ingress servers, and basic auth and redirects are published only to the server it runs on. Remove its ingress servers, or its basic auth and redirects.`,
	});

/** Called by the basic-auth and redirect writers, which do not pass through manageDomain. */
export const assertNoIngressServers = (app: ApplicationNested) => {
	if (ingressTargets(app).length > 1) {
		throw ingressMiddlewareUnsupported(app);
	}
};

export const manageDomain = async (app: ApplicationNested, domain: Domain) => {
	const targets = ingressTargets(app);
	if (domain.enabled) {
		assertMultiIngressSupported(app, domain, targets.length);
	}
	for (const target of targets) {
		await manageDomainOnServer(target, domain);
	}
};

const manageDomainOnServer = async (app: ApplicationNested, domain: Domain) => {
	const { appName } = app;

	// A disabled domain keeps its configuration in the database but must never
	// expose a traefik router. Guarding here covers every caller (create, update,
	// forward-auth, toggle) so a disabled domain can't be revived from any path.
	if (!domain.enabled) {
		await removeDomainOnServer(app, domain.uniqueConfigKey);
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

	config.http.services[serviceName] = createServiceConfig(app, domain);
	const transportName = `${appName}-swarm-vip`;
	if (app.swarmVipConnectionReuse) {
		for (const [name, service] of Object.entries(config.http.services)) {
			if (
				name.startsWith(`${appName}-service-`) &&
				"loadBalancer" in service &&
				service.loadBalancer?.serversTransport === transportName
			) {
				delete service.loadBalancer?.serversTransport;
			}
		}
		delete config.http.serversTransports?.[transportName];
		if (
			config.http.serversTransports &&
			Object.keys(config.http.serversTransports).length === 0
		) {
			delete config.http.serversTransports;
		}
	} else {
		config.http.serversTransports ??= {};
		config.http.serversTransports[transportName] = {
			maxIdleConnsPerHost: -1,
		};
	}

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
	for (const target of ingressTargets(application)) {
		await removeDomainOnServer(target, uniqueKey);
	}
};

const removeDomainOnServer = async (
	application: ApplicationNested,
	uniqueKey: number,
) => {
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
