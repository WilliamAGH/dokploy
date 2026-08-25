import _ from "lodash";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type {
	ComposeSpecification,
	DefinitionsService,
	DefinitionsVolume,
} from "../types";

export type ServiceVolume = {
	serviceName: string;
	type: string;
	source: string;
	target: string;
};

// Función para agregar prefijo a volúmenes
export const addSuffixToVolumesRoot = (
	volumes: { [key: string]: DefinitionsVolume },
	suffix: string,
): { [key: string]: DefinitionsVolume } => {
	return _.mapKeys(volumes, (_value, key) => `${key}-${suffix}`);
};

export const addSuffixToVolumesInServices = (
	services: { [key: string]: DefinitionsService },
	suffix: string,
): { [key: string]: DefinitionsService } => {
	const newServices: { [key: string]: DefinitionsService } = {};

	_.forEach(services, (serviceConfig, serviceName) => {
		const newServiceConfig = _.cloneDeep(serviceConfig);

		// Reemplazar nombres de volúmenes en volumes
		if (_.has(newServiceConfig, "volumes")) {
			newServiceConfig.volumes = _.map(newServiceConfig.volumes, (volume) => {
				if (_.isString(volume)) {
					// remainder is the container path plus optional access mode (:ro, :z, :Z)
					const [volumeName, ...pathAndMode] = volume.split(":");
					const remainder = pathAndMode.join(":");

					// skip bind mounts and variables (e.g. $PWD)
					if (
						!volumeName ||
						!remainder ||
						volumeName.startsWith(".") ||
						volumeName.startsWith("/") ||
						volumeName.startsWith("$")
					) {
						return volume;
					}

					// Handle volume paths with subdirectories
					const parts = volumeName.split("/");
					if (parts.length > 1) {
						const baseName = parts[0];
						const rest = parts.slice(1).join("/");
						return `${baseName}-${suffix}/${rest}:${remainder}`;
					}

					return `${volumeName}-${suffix}:${remainder}`;
				}
				if (_.isObject(volume) && volume.type === "volume" && volume.source) {
					return {
						...volume,
						source: `${volume.source}-${suffix}`,
					};
				}
				return volume;
			});
		}

		newServices[serviceName] = newServiceConfig;
	});

	return newServices;
};

export const extractServiceVolumes = (
	composeData: ComposeSpecification,
): ServiceVolume[] => {
	if (!composeData.services) {
		return [];
	}

	const result: ServiceVolume[] = [];

	for (const [serviceName, serviceConfig] of Object.entries(
		composeData.services,
	)) {
		if (!serviceConfig.volumes) {
			continue;
		}
		for (const vol of serviceConfig.volumes) {
			if (_.isString(vol)) {
				const parts = vol.split(":");
				const source = parts.length === 1 ? "" : parts[0] || "";
				const target = parts.length === 1 ? parts[0] || "" : parts[1] || "";
				const isBind =
					source.startsWith(".") ||
					source.startsWith("/") ||
					source.startsWith("$");
				result.push({
					serviceName,
					type: isBind ? "bind" : "volume",
					source,
					target,
				});
			} else {
				result.push({
					serviceName,
					type: vol.type,
					source: vol.source || "",
					target: vol.target || "",
				});
			}
		}
	}

	return result;
};

const parseComposeDocument = (composeFile: string) => {
	const document = parseDocument(composeFile);
	if (document.errors.length > 0) {
		throw document.errors[0];
	}
	return document;
};

const getServiceVolumes = (composeFile: string, serviceName: string) => {
	const document = parseComposeDocument(composeFile);
	const service = document.getIn(["services", serviceName], true);
	if (!isMap(service)) {
		throw new Error("Compose service not found");
	}

	let volumes = service.get("volumes", true);
	if (volumes === undefined) {
		service.set("volumes", []);
		volumes = service.get("volumes", true);
	}
	if (!isSeq(volumes)) {
		throw new Error("Compose service volumes must be a sequence");
	}
	return { document, volumes };
};

const getVolumeTarget = (volume: unknown) => {
	if (isScalar(volume)) {
		const parts = String(volume.value).split(":");
		return parts.length === 1 ? parts[0] : parts[1];
	}
	if (isMap(volume)) {
		const target = volume.get("target");
		return typeof target === "string" ? target : undefined;
	}
	return undefined;
};

export const addVolumeToComposeFile = (
	composeFile: string,
	serviceName: string,
	volume: string,
) => {
	const { document, volumes } = getServiceVolumes(composeFile, serviceName);
	volumes.add(volume);
	return document.toString();
};

export const removeVolumeFromComposeFile = (
	composeFile: string,
	serviceName: string,
	target: string,
) => {
	const { document, volumes } = getServiceVolumes(composeFile, serviceName);
	const index = volumes.items.findIndex(
		(volume) => getVolumeTarget(volume) === target,
	);
	if (index < 0) {
		throw new Error("Compose volume not found");
	}
	volumes.delete(index);
	return document.toString();
};

export const updateVolumeInComposeFile = (
	composeFile: string,
	serviceName: string,
	originalTarget: string,
	source: string,
	target: string,
) => {
	const { document, volumes } = getServiceVolumes(composeFile, serviceName);
	const volume = volumes.items.find(
		(item) => getVolumeTarget(item) === originalTarget,
	);
	if (isScalar(volume)) {
		const parts = String(volume.value).split(":");
		const options = parts.length === 1 ? [] : parts.slice(2);
		volume.value = [source, target, ...options].filter(Boolean).join(":");
	} else if (isMap(volume)) {
		volume.set("source", source);
		volume.set("target", target);
	} else {
		throw new Error("Compose volume not found");
	}
	return document.toString();
};

export const addSuffixToAllVolumes = (
	composeData: ComposeSpecification,
	suffix: string,
): ComposeSpecification => {
	const updatedComposeData = { ...composeData };

	if (updatedComposeData.volumes) {
		updatedComposeData.volumes = addSuffixToVolumesRoot(
			updatedComposeData.volumes,
			suffix,
		);
	}

	if (updatedComposeData.services) {
		updatedComposeData.services = addSuffixToVolumesInServices(
			updatedComposeData.services,
			suffix,
		);
	}

	return updatedComposeData;
};
