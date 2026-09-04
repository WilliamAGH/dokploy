import {
	findRegistryByIdWithCredentials,
	type Registry,
} from "@dokploy/server/services/registry";

type RegistrySource = {
	buildRegistry?: Pick<Registry, "registryId"> | null;
	password?: string | null;
	registry?: Pick<Registry, "registryId"> | null;
	registryUrl?: string | null;
	sourceType?: string | null;
	username?: string | null;
};

export const getAuthConfig = async (source: RegistrySource) => {
	if (source.sourceType === "docker" && source.username && source.password) {
		return {
			password: source.password,
			username: source.username,
			serveraddress: source.registryUrl || "",
		};
	}
	const registryReference = source.registry ?? source.buildRegistry;
	if (!registryReference) return;

	const resolved = await findRegistryByIdWithCredentials(
		registryReference.registryId,
	);
	return {
		password: resolved.password,
		username: resolved.username,
		serveraddress: resolved.registryUrl,
	};
};
