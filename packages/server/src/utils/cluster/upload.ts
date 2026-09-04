import {
	findAllRegistryByOrganizationId,
	findRegistryByIdWithCredentials,
	type Registry,
	safeDockerLoginCommand,
} from "@dokploy/server/services/registry";
import {
	confirmRollback,
	createRollback,
	discardRollback,
} from "@dokploy/server/services/rollbacks";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { quote } from "shell-quote";
import type { ApplicationNested } from "../builders";
import { getAuthConfig } from "../builders/auth";

export const isImmutableImage = (image: string) =>
	/@sha256:[a-f0-9]{64}$/.test(image);

const normalizeRegistryHost = (host: string | undefined) => {
	if (!host) return "docker.io";
	const normalized = host.toLowerCase();
	return normalized === "index.docker.io" ||
		normalized === "registry-1.docker.io"
		? "docker.io"
		: normalized;
};

const getImageRegistryHost = (reference: string) => {
	const [first, ...path] = reference.replace(/^https?:\/\//, "").split("/");
	const host = first?.toLowerCase();
	if (
		!host ||
		path.length === 0 ||
		(!host.includes(".") && !host.includes(":") && host !== "localhost")
	)
		return "docker.io";
	return normalizeRegistryHost(host);
};

const getRegistryHost = (reference: string) =>
	normalizeRegistryHost(reference.replace(/^https?:\/\//, "").split("/")[0]);

const getImageNamespace = (reference: string) => {
	const parts = reference.replace(/^https?:\/\//, "").split("/");
	const first = parts[0] ?? "";
	const path =
		first.includes(".") || first.includes(":") || first === "localhost"
			? parts.slice(1)
			: parts;
	return path.length > 1 ? path[0]?.toLowerCase() : undefined;
};

export const uploadImageRemoteCommand = async (
	application: ApplicationNested,
	deploymentId?: string,
	rollbackContext: ApplicationNested = application,
) => {
	const registry = application.registry;
	const buildRegistry = application.buildRegistry;
	const rollbackRegistry = application.rollbackRegistry;

	if (!registry && !buildRegistry && !rollbackRegistry) {
		throw new Error("No registry found");
	}

	const { appName } = application;
	const imageName =
		application.sourceType === "docker"
			? application.dockerImage || ""
			: `${appName}:latest`;
	const dockerSource = application.sourceType === "docker";
	const immutableDockerSource = dockerSource && isImmutableImage(imageName);

	const commands: string[] = [];
	if (registry && !immutableDockerSource) {
		const r = await findRegistryByIdWithCredentials(registry.registryId);
		const registryTag = getRegistryTag(r, imageName);
		if (registryTag) {
			commands.push(`echo "📦 [Enabled Registry Swarm]"`);
			commands.push(getRegistryCommands(r, imageName, registryTag));
		}
	}
	if (buildRegistry && !immutableDockerSource) {
		const r = await findRegistryByIdWithCredentials(buildRegistry.registryId);
		const buildRegistryTag = getRegistryTag(r, imageName);
		if (buildRegistryTag) {
			commands.push(`echo "🔑 [Enabled Build Registry]"`);
			commands.push(getRegistryCommands(r, imageName, buildRegistryTag));
			commands.push(
				`echo "⚠️ INFO: After the build is finished, you need to wait a few seconds for the server to download the image and run the container."`,
			);
			commands.push(
				`echo "📊 Check the Logs tab to see when the container starts running."`,
			);
		}
	}

	if (rollbackRegistry && application.rollbackActive) {
		if (!deploymentId) throw new Error("Deployment not found");
		let rollbackSource:
			| { image: string; labels: Record<string, string> }
			| undefined;
		try {
			const docker = await getRemoteDocker(application.serverId);
			const service = await docker.getService(appName).inspect();
			const container = service.Spec?.TaskTemplate?.ContainerSpec;
			if (!container?.Image) {
				throw new Error("Live service image not found");
			}
			rollbackSource = {
				image: container.Image,
				labels: container.Labels ?? {},
			};
		} catch (error) {
			const statusCode = (error as { statusCode?: number })?.statusCode;
			if (statusCode === 404) {
				return commands.join("\n");
			}
			throw error;
		}
		const registryBackedSource =
			dockerSource || rollbackSource.image !== `${appName}:latest`;
		const destinationRegistry = await findRegistryByIdWithCredentials(
			rollbackRegistry.registryId,
		);
		const configuredSourceAuth = registryBackedSource
			? await getAuthConfig(application)
			: undefined;
		const destinationAuth = {
			password: destinationRegistry.password,
			serveraddress: destinationRegistry.registryUrl,
			username: destinationRegistry.username,
		};
		const sourceHost = getImageRegistryHost(rollbackSource?.image ?? imageName);
		const sourceNamespace = getImageNamespace(rollbackSource.image);
		const configuredSourceNamespace = dockerSource
			? getImageNamespace(imageName)
			: (
					registry?.imagePrefix ??
					registry?.username ??
					buildRegistry?.imagePrefix ??
					buildRegistry?.username
				)?.toLowerCase();
		let sourceAuth = configuredSourceAuth;
		if (
			!sourceAuth ||
			getRegistryHost(sourceAuth.serveraddress) !== sourceHost ||
			(sourceNamespace !== undefined &&
				configuredSourceNamespace !== undefined &&
				sourceNamespace !== configuredSourceNamespace)
		) {
			const destinationNamespace = (
				destinationRegistry.imagePrefix || destinationRegistry.username
			).toLowerCase();
			sourceAuth =
				getRegistryHost(destinationAuth.serveraddress) === sourceHost &&
				(!sourceNamespace || sourceNamespace === destinationNamespace)
					? destinationAuth
					: undefined;
		}
		if (!sourceAuth && registryBackedSource) {
			const sourceRegistry = (
				await findAllRegistryByOrganizationId(
					application.environment.project.organizationId,
				)
			).filter(
				(registry) => getRegistryHost(registry.registryUrl) === sourceHost,
			);
			const matchingRegistry = sourceRegistry.filter(
				(registry) =>
					!sourceNamespace ||
					[registry.imagePrefix, registry.username]
						.filter(Boolean)
						.some((prefix) => prefix?.toLowerCase() === sourceNamespace),
			);
			if (matchingRegistry.length > 1) {
				throw new Error("Multiple registries match the rollback source image");
			}
			if (matchingRegistry[0]) {
				sourceAuth = {
					password: matchingRegistry[0].password,
					serveraddress: matchingRegistry[0].registryUrl,
					username: matchingRegistry[0].username,
				};
			}
		}
		if (
			sourceAuth &&
			getRegistryHost(sourceAuth.serveraddress) ===
				getRegistryHost(destinationAuth.serveraddress) &&
			(sourceAuth.username !== destinationAuth.username ||
				sourceAuth.password !== destinationAuth.password)
		) {
			throw new Error(
				"Source and rollback repositories on one registry host require the same credentials",
			);
		}
		const rollback = await createRollback({
			appName: appName,
			deploymentId,
			fullContext: rollbackContext,
			...(rollbackSource && {
				rollbackSource: {
					...rollbackSource,
					...(sourceAuth && { authConfig: sourceAuth }),
				},
			}),
		});

		if (!rollback?.rollbackId || !rollback.image) {
			throw new Error("Failed to create rollback");
		}
		const rollbackRegistryTag = getRegistryTag(
			destinationRegistry,
			rollback.image,
		);
		if (rollbackRegistryTag) {
			const archiveCommand = `echo "🔄 [Enabled Rollback Registry]";
${getRegistryCommands(
	destinationRegistry,
	rollbackSource?.image ?? imageName,
	rollbackRegistryTag,
	sourceAuth,
	registryBackedSource,
)}`;
			try {
				const archiveServerId = registryBackedSource
					? application.buildServerId || application.serverId
					: application.serverId;
				if (archiveServerId) {
					await execAsyncRemote(archiveServerId, archiveCommand);
				} else {
					await execAsync(archiveCommand);
				}
				await confirmRollback(rollback.rollbackId, deploymentId);
			} catch (error) {
				await discardRollback(rollback.rollbackId, deploymentId);
				throw error;
			}
		}
	}
	return commands.join("\n");
};

/**
 * Extract the repository name from imageName by taking the last part after '/'
 * Examples:
 * - "nginx" -> "nginx"
 * - "nginx:latest" -> "nginx:latest"
 * - "myuser/myrepo" -> "myrepo"
 * - "myuser/myrepo:tag" -> "myrepo:tag"
 * - "docker.io/myuser/myrepo" -> "myrepo"
 */
const extractRepositoryName = (imageName: string): string => {
	const lastSlashIndex = imageName.lastIndexOf("/");

	// If no '/', return the imageName as is
	if (lastSlashIndex === -1) {
		return imageName;
	}

	// Extract everything after the last '/'
	return imageName.substring(lastSlashIndex + 1);
};

export const getRegistryTag = (registry: Registry, imageName: string) => {
	const { registryUrl, imagePrefix, username } = registry;

	// Extract the repository name (last part after '/')
	const repositoryName = extractRepositoryName(imageName);

	// Build the final tag using registry's username/prefix (must be lowercase for valid image refs)
	const targetPrefix = (imagePrefix || username).toLowerCase();
	const finalRegistry = registryUrl || "";

	return finalRegistry
		? `${finalRegistry}/${targetPrefix}/${repositoryName}`
		: `${targetPrefix}/${repositoryName}`;
};

const getRegistryCommands = (
	registry: Registry,
	imageName: string,
	registryTag: string,
	sourceAuth?: NonNullable<Awaited<ReturnType<typeof getAuthConfig>>>,
	copyManifest = false,
): string => {
	const loginCmd = safeDockerLoginCommand(
		registry.registryUrl,
		registry.username,
		registry.password,
	);
	const quotedImageName = quote([imageName]);
	const immutableImage = isImmutableImage(imageName);
	const tagSource = immutableImage
		? `$(docker image inspect --format '{{.Id}}' ${quotedImageName})`
		: quotedImageName;
	const pullCommand = copyManifest
		? `${sourceAuth ? `${safeDockerLoginCommand(sourceAuth.serveraddress, sourceAuth.username, sourceAuth.password)} || { echo "❌ Source registry login failed"; exit 1; }` : ""}
docker pull ${quotedImageName} || docker buildx imagetools inspect ${quotedImageName} >/dev/null || {
	echo "❌ Error reading source image" ;
	exit 1;
}`
		: "";
	const publishCommand = copyManifest
		? `docker buildx imagetools create --prefer-index=false --tag ${quote([registryTag])} ${quotedImageName}`
		: `docker tag ${tagSource} ${quote([registryTag])} && docker push ${quote([registryTag])}`;
	return `
echo ${quote([`📦 [Enabled Registry] Uploading image to '${registry.registryType}' | '${registryTag}'`])} ;
${pullCommand}
${loginCmd} || {
	echo "❌ DockerHub Failed" ;
	exit 1;
}
echo "✅ Registry Login Success" ;
${publishCommand} || {
	echo "❌ Error publishing image" ;
	exit 1;
}
	echo "✅ Image Published" ;
`;
};
