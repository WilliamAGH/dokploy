import {
	findServerById,
	findServersByOrganizationId,
} from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import type { CreateServiceOptions } from "dockerode";
import { IS_CLOUD } from "../constants";
import { getDokployImageTag } from "../services/settings";
import { pullImage, pullRemoteImage } from "../utils/docker/utils";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";

const getMonitoringImage = () => {
	if (process.env.MONITORING_IMAGE) {
		return process.env.MONITORING_IMAGE;
	}

	let imageName = "dokploy/monitoring:latest";

	if (
		(getDokployImageTag() !== "latest" ||
			process.env.NODE_ENV === "development") &&
		!IS_CLOUD
	) {
		imageName = "dokploy/monitoring:canary";
	}

	return imageName;
};

// Swarm tasks are dokploy-monitoring.<slot>.<id>, so this only matches the
// pre-v0.30.0 standalone container. A cleanup failure must not block the deploy.
const removeLegacyContainer = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	serviceName: string,
) => {
	try {
		await docker.getContainer(serviceName).remove({ force: true });
		console.log("Removed legacy monitoring container ✅");
	} catch (error: any) {
		if (error?.statusCode !== 404) {
			console.warn(
				`Could not remove legacy monitoring container: ${error?.message ?? error}`,
			);
		}
	}
};

// The monitoring agent is a per-host daemon: it reads the node's own
// docker.sock, /proc and /sys and binds one metrics port on it. Every node
// therefore needs its own service, and every service must be pinned to the node
// whose metrics it reports. The bare name belongs to the control plane's own
// node; remote servers are suffixed with the Swarm node they monitor.
//
// Keying on the node rather than the server row matters: the same machine can
// be registered as a server in more than one organization, and those rows must
// converge on the one agent that machine can actually run.
const CONTROL_PLANE_SERVICE_NAME = "dokploy-monitoring";

const monitoringServiceName = (nodeId: string) =>
	`${CONTROL_PLANE_SERVICE_NAME}-${nodeId}`;

interface SwarmIdentity {
	nodeId: string;
	isManager: boolean;
	managerNodeIds: string[];
}

const readSwarmIdentity = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
): Promise<SwarmIdentity> => {
	const info = (await docker.info()) as {
		Swarm?: {
			NodeID?: string;
			ControlAvailable?: boolean;
			RemoteManagers?: { NodeID?: string }[] | null;
		};
	};
	const swarm = info?.Swarm;

	if (!swarm?.NodeID) {
		throw new Error(
			"Monitoring requires the node to be part of a Docker Swarm. Run Setup Server first.",
		);
	}

	return {
		nodeId: swarm.NodeID,
		isManager: Boolean(swarm.ControlAvailable),
		managerNodeIds: (swarm.RemoteManagers ?? [])
			.map((manager) => manager?.NodeID)
			.filter((nodeId): nodeId is string => Boolean(nodeId)),
	};
};

// A worker's Docker daemon rejects service creation, so its agent has to be
// deployed through another server that Dokploy already manages and that is a
// manager of the same swarm. `RemoteManagers` is the only cluster identity a
// worker can report: `Swarm.Cluster` is null unless the node is a manager.
const findSwarmManagerServerId = async (
	targetServer: Awaited<ReturnType<typeof findServerById>>,
	swarm: SwarmIdentity,
) => {
	const managerNodeIds = new Set(swarm.managerNodeIds);
	const candidates = await findServersByOrganizationId(
		targetServer.organizationId,
	);

	for (const candidate of candidates) {
		if (candidate.serverId === targetServer.serverId) continue;

		try {
			const identity = await readSwarmIdentity(
				await getRemoteDocker(candidate.serverId),
			);
			if (identity.isManager && managerNodeIds.has(identity.nodeId)) {
				return candidate.serverId;
			}
		} catch {
			// An unreachable or non-swarm candidate simply is not a usable manager.
		}
	}

	throw new Error(
		`${targetServer.name} is a Swarm worker and no other server in this organization is a manager of its swarm. Add one of its managers as a server before enabling monitoring.`,
	);
};

const controlPlaneNodeId = async () => {
	try {
		const identity = await readSwarmIdentity(await getRemoteDocker());
		return identity.nodeId;
	} catch {
		// A control plane outside any swarm owns no monitoring node.
		return null;
	}
};

// Previously every remote server deployed one service literally named
// `dokploy-monitoring`, so a multi-node swarm ended up with a single agent
// reporting metrics for one node only. That service still binds the metrics
// port on whichever node it landed on, so it has to go before the per-host
// agents start. The control plane keeps the name for its own node, so it is
// only removed from swarms the control plane is not part of.
const removeLegacySharedService = async (
	managerDocker: Awaited<ReturnType<typeof getRemoteDocker>>,
) => {
	try {
		const controlPlaneId = await controlPlaneNodeId();
		const nodes = (await managerDocker.listNodes()) as { ID?: string }[];
		if (controlPlaneId && nodes.some((node) => node?.ID === controlPlaneId)) {
			return;
		}
	} catch {
		// An unreadable node list is not proof the legacy service is ours to keep.
	}

	try {
		await managerDocker.getService(CONTROL_PLANE_SERVICE_NAME).remove();
		console.log("Removed legacy shared monitoring service ✅");
	} catch (error: any) {
		if (error?.statusCode !== 404) {
			console.warn(
				`Could not remove legacy shared monitoring service: ${error?.message ?? error}`,
			);
		}
	}
};

const deployMonitoringService = async (
	docker: Awaited<ReturnType<typeof getRemoteDocker>>,
	serviceName: string,
	settings: CreateServiceOptions,
) => {
	try {
		const service = docker.getService(serviceName);
		const inspect = await service.inspect();
		await service.update({
			version: Number.parseInt(inspect.Version.Index),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
			},
		});
		console.log("Monitoring Updated ✅");
	} catch (error: any) {
		if (error?.statusCode && error.statusCode !== 404) {
			throw error;
		}
		await docker.createService(settings);
		console.log("Monitoring Started ✅");
	}
};

export const setupMonitoring = async (serverId: string) => {
	const server = await findServerById(serverId);

	const imageName = getMonitoringImage();

	const targetDocker = await getRemoteDocker(serverId);
	const swarm = await readSwarmIdentity(targetDocker);
	const serviceName = monitoringServiceName(swarm.nodeId);

	// The control plane monitors its own node through `setupWebMonitoring`. A
	// second agent there would race it for the metrics port and crash-loop.
	if (swarm.nodeId === (await controlPlaneNodeId())) {
		console.log(
			`${server.name} is the Dokploy control plane node; its metrics come from the built-in monitoring service.`,
		);
		return;
	}

	const managerServerId = swarm.isManager
		? serverId
		: await findSwarmManagerServerId(server, swarm);

	const settings: CreateServiceOptions = {
		Name: serviceName,
		Labels: {
			"dokploy.monitoring.serverId": serverId,
			"dokploy.monitoring.serverName": server.name,
		},
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [`METRICS_CONFIG=${JSON.stringify(server?.metricsConfig)}`],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/sys",
						Target: "/host/sys",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/os-release",
						Target: "/etc/os-release",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/proc",
						Target: "/host/proc",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/dokploy/monitoring/monitoring.db",
						Target: "/app/monitoring.db",
					},
				],
			},
			Networks: [{ Target: "host" }],
			Placement: {
				Constraints: [`node.id==${swarm.nodeId}`],
			},
		},
		Mode: {
			Replicated: {
				Replicas: 1,
			},
		},
	};

	const docker = await getRemoteDocker(managerServerId);

	await execAsyncRemote(
		serverId,
		"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
	);
	await pullRemoteImage(imageName, serverId);
	await removeLegacyContainer(targetDocker, CONTROL_PLANE_SERVICE_NAME);
	await removeLegacySharedService(docker);
	await deployMonitoringService(docker, serviceName, settings);
};

export const setupWebMonitoring = async () => {
	const webServerSettings = await getWebServerSettings();

	const serviceName = CONTROL_PLANE_SERVICE_NAME;
	const imageName = getMonitoringImage();
	const port = webServerSettings?.metricsConfig?.server?.port;

	const docker = await getRemoteDocker();
	const controlPlane = await readSwarmIdentity(docker);

	const settings: CreateServiceOptions = {
		Name: serviceName,
		TaskTemplate: {
			ContainerSpec: {
				Image: imageName,
				Env: [
					`METRICS_CONFIG=${JSON.stringify(webServerSettings?.metricsConfig)}`,
				],
				Mounts: [
					{
						Type: "bind",
						Source: "/var/run/docker.sock",
						Target: "/var/run/docker.sock",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/sys",
						Target: "/host/sys",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/os-release",
						Target: "/etc/os-release",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/proc",
						Target: "/host/proc",
						ReadOnly: true,
					},
					{
						Type: "bind",
						Source: "/etc/dokploy/monitoring/monitoring.db",
						Target: "/app/monitoring.db",
					},
				],
			},
			Placement: {
				Constraints: [`node.id==${controlPlane.nodeId}`],
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
					TargetPort: port,
					PublishedPort: port,
					Protocol: "tcp",
					PublishMode: "host",
				},
			],
		},
	};

	await execAsync(
		"mkdir -p /etc/dokploy/monitoring && touch /etc/dokploy/monitoring/monitoring.db",
	);
	await pullImage(imageName);
	await removeLegacyContainer(docker, serviceName);
	await deployMonitoringService(docker, serviceName, settings);
};
