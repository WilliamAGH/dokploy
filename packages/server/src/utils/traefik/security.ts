import type { Security } from "@dokploy/server/services/security";
import * as bcrypt from "bcrypt";
import type { ApplicationNested } from "../builders";
import {
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
	writeTraefikConfig,
	writeTraefikConfigRemote,
} from "./application";
import { usesSwarmReadinessRouting } from "./domain";
import type {
	BasicAuthMiddleware,
	FileConfig,
	HttpMiddleware,
} from "./file-types";
import {
	addMiddleware,
	deleteMiddleware,
	loadMiddlewares,
	loadRemoteMiddlewares,
	writeMiddleware,
} from "./middleware";

export const createSecurityMiddleware = async (
	application: ApplicationNested,
	data: Security,
) => {
	const { appName, serverId } = application;
	let config: FileConfig;

	if (serverId) {
		config = await loadRemoteMiddlewares(serverId);
	} else {
		config = loadMiddlewares<FileConfig>();
	}
	const middlewareName = `auth-${appName}`;

	const user = `${data.username}:${await bcrypt.hash(data.password, 10)}`;

	if (config.http?.middlewares) {
		const currentMiddleware = config.http.middlewares[middlewareName];
		if (isBasicAuthMiddleware(currentMiddleware)) {
			currentMiddleware.basicAuth.users = [
				...(currentMiddleware.basicAuth.users || []),
				user,
			];
		} else {
			config.http.middlewares[middlewareName] = {
				basicAuth: {
					removeHeader: true,
					users: [user],
				},
			};
		}
	}
	if (usesSwarmReadinessRouting(application)) {
		if (serverId) {
			await writeTraefikConfigRemote(config, "middlewares", serverId);
		} else {
			writeMiddleware(config);
		}
		return;
	}
	const appConfig = serverId
		? await loadOrCreateConfigRemote(serverId, appName)
		: loadOrCreateConfig(appName);
	addMiddleware(appConfig, middlewareName);
	if (serverId) {
		await writeTraefikConfigRemote(config, "middlewares", serverId);
		await writeTraefikConfigRemote(appConfig, appName, serverId);
	} else {
		writeTraefikConfig(appConfig, appName);
		writeMiddleware(config);
	}
};

export const removeSecurityMiddleware = async (
	application: ApplicationNested,
	data: Security,
) => {
	const { appName, serverId } = application;
	let config: FileConfig;

	if (serverId) {
		config = await loadRemoteMiddlewares(serverId);
	} else {
		config = loadMiddlewares<FileConfig>();
	}
	const appConfig = usesSwarmReadinessRouting(application)
		? undefined
		: serverId
			? await loadOrCreateConfigRemote(serverId, appName)
			: loadOrCreateConfig(appName);
	const middlewareName = `auth-${appName}`;

	if (config.http?.middlewares) {
		const currentMiddleware = config.http.middlewares[middlewareName];
		if (isBasicAuthMiddleware(currentMiddleware)) {
			const users = currentMiddleware.basicAuth.users;
			const filteredUsers =
				users?.filter((user) => {
					const [username] = user.split(":");
					return username !== data.username;
				}) || [];
			currentMiddleware.basicAuth.users = filteredUsers;

			if (filteredUsers.length === 0) {
				if (config?.http?.middlewares?.[middlewareName]) {
					delete config.http.middlewares[middlewareName];
				}
				if (appConfig) {
					deleteMiddleware(appConfig, middlewareName);
					if (serverId) {
						await writeTraefikConfigRemote(appConfig, appName, serverId);
					} else {
						writeTraefikConfig(appConfig, appName);
					}
				}
			}
		}
	}

	if (serverId) {
		await writeTraefikConfigRemote(config, "middlewares", serverId);
	} else {
		writeMiddleware(config);
	}
};

const isBasicAuthMiddleware = (
	middleware: HttpMiddleware | undefined,
): middleware is { basicAuth: BasicAuthMiddleware } => {
	return !!middleware && "basicAuth" in middleware;
};
