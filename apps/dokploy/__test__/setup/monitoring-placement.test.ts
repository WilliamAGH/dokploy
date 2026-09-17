import {
	setupMonitoring,
	setupWebMonitoring,
} from "@dokploy/server/setup/monitoring-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findServerById: vi.fn(),
	findServersByOrganizationId: vi.fn(),
	getWebServerSettings: vi.fn(),
	getDokployImageTag: vi.fn(),
	pullImage: vi.fn(),
	pullRemoteImage: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
	getRemoteDocker: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({ IS_CLOUD: false }));
vi.mock("@dokploy/server/services/server", () => ({
	findServerById: mocks.findServerById,
	findServersByOrganizationId: mocks.findServersByOrganizationId,
}));
vi.mock("@dokploy/server/services/settings", () => ({
	getDokployImageTag: mocks.getDokployImageTag,
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: mocks.getWebServerSettings,
}));
vi.mock("@dokploy/server/utils/docker/utils", () => ({
	pullImage: mocks.pullImage,
	pullRemoteImage: mocks.pullRemoteImage,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: mocks.getRemoteDocker,
}));

const notFound = () =>
	Object.assign(new Error("not found"), { statusCode: 404 });

const CONTROL_PLANE_NODE = "node-control-plane";
const MANAGER_NODE = "node-manager";
const WORKER_NODE = "node-worker";

interface FakeDockerOptions {
	nodeId: string;
	isManager: boolean;
	managerNodeIds?: string[];
	swarmNodeIds?: string[];
}

const createDocker = ({
	nodeId,
	isManager,
	managerNodeIds = [MANAGER_NODE],
	swarmNodeIds = [MANAGER_NODE, WORKER_NODE],
}: FakeDockerOptions) => {
	const removeLegacyService = vi.fn().mockResolvedValue(undefined);
	return {
		removeLegacyService,
		createService: vi.fn().mockResolvedValue(undefined),
		info: vi.fn().mockResolvedValue({
			Swarm: {
				NodeID: nodeId,
				ControlAvailable: isManager,
				RemoteManagers: managerNodeIds.map((id) => ({ NodeID: id })),
			},
		}),
		listNodes: vi
			.fn()
			.mockResolvedValue(swarmNodeIds.map((id) => ({ ID: id }))),
		getContainer: vi.fn(() => ({
			remove: vi.fn().mockRejectedValue(notFound()),
		})),
		getService: vi.fn((name: string) => ({
			inspect: vi.fn().mockRejectedValue(notFound()),
			remove:
				name === "dokploy-monitoring"
					? removeLegacyService
					: vi.fn().mockRejectedValue(notFound()),
		})),
	};
};

let controlPlaneDocker: ReturnType<typeof createDocker>;
let managerDocker: ReturnType<typeof createDocker>;
let workerDocker: ReturnType<typeof createDocker>;

beforeEach(() => {
	vi.clearAllMocks();
	controlPlaneDocker = createDocker({
		nodeId: CONTROL_PLANE_NODE,
		isManager: true,
		swarmNodeIds: [CONTROL_PLANE_NODE],
	});
	managerDocker = createDocker({ nodeId: MANAGER_NODE, isManager: true });
	workerDocker = createDocker({ nodeId: WORKER_NODE, isManager: false });

	mocks.getDokployImageTag.mockReturnValue("latest");
	mocks.execAsync.mockResolvedValue({ stderr: "", stdout: "" });
	mocks.execAsyncRemote.mockResolvedValue({ stderr: "", stdout: "" });
	mocks.getWebServerSettings.mockResolvedValue({
		metricsConfig: { server: { port: 4500 } },
	});
	mocks.getRemoteDocker.mockImplementation((serverId?: string) => {
		if (!serverId) return Promise.resolve(controlPlaneDocker);
		if (serverId === "worker-server") return Promise.resolve(workerDocker);
		return Promise.resolve(managerDocker);
	});
});

const managerServer = {
	serverId: "manager-server",
	name: "haiku-manager",
	organizationId: "org-id",
	metricsConfig: {},
};

const workerServer = {
	serverId: "worker-server",
	name: "haiku-worker",
	organizationId: "org-id",
	metricsConfig: {},
};

describe("monitoring placement", () => {
	it("gives each server its own service pinned to that server's node", async () => {
		mocks.findServerById.mockResolvedValue(managerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([managerServer]);

		await setupMonitoring("manager-server");

		expect(managerDocker.createService).toHaveBeenCalledWith(
			expect.objectContaining({
				Name: `dokploy-monitoring-${MANAGER_NODE}`,
				TaskTemplate: expect.objectContaining({
					Placement: { Constraints: [`node.id==${MANAGER_NODE}`] },
				}),
			}),
		);
	});

	it("deploys a worker's agent through a manager of the same swarm", async () => {
		mocks.findServerById.mockResolvedValue(workerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([
			workerServer,
			managerServer,
		]);

		await setupMonitoring("worker-server");

		// the service is created on the manager's daemon...
		expect(managerDocker.createService).toHaveBeenCalledTimes(1);
		expect(workerDocker.createService).not.toHaveBeenCalled();
		// ...but still pinned to the worker node it reports metrics for.
		expect(managerDocker.createService).toHaveBeenCalledWith(
			expect.objectContaining({
				Name: `dokploy-monitoring-${WORKER_NODE}`,
				TaskTemplate: expect.objectContaining({
					Placement: { Constraints: [`node.id==${WORKER_NODE}`] },
				}),
			}),
		);
	});

	it("gives two org rows for one machine the same node-keyed service", async () => {
		const otherOrgRow = {
			serverId: "manager-server-other-org",
			name: "haiku-manager",
			organizationId: "org-two",
			metricsConfig: {},
		};
		mocks.findServerById.mockResolvedValue(managerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([managerServer]);
		await setupMonitoring("manager-server");

		mocks.findServerById.mockResolvedValue(otherOrgRow);
		mocks.findServersByOrganizationId.mockResolvedValue([otherOrgRow]);
		await setupMonitoring("manager-server-other-org");

		// one machine can only run one agent on one metrics port
		const names = managerDocker.createService.mock.calls.map(
			([settings]) => settings.Name,
		);
		expect(names).toEqual([
			`dokploy-monitoring-${MANAGER_NODE}`,
			`dokploy-monitoring-${MANAGER_NODE}`,
		]);
	});

	it("fails with an actionable message when no manager server is registered", async () => {
		mocks.findServerById.mockResolvedValue(workerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([workerServer]);

		await expect(setupMonitoring("worker-server")).rejects.toThrow(
			/Swarm worker and no other server/,
		);
		expect(managerDocker.createService).not.toHaveBeenCalled();
	});

	it("removes the legacy shared service from swarms the control plane is not in", async () => {
		mocks.findServerById.mockResolvedValue(managerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([managerServer]);

		await setupMonitoring("manager-server");

		expect(managerDocker.removeLegacyService).toHaveBeenCalled();
	});

	it("keeps the legacy shared service when it belongs to the control plane's swarm", async () => {
		managerDocker.listNodes.mockResolvedValue([
			{ ID: MANAGER_NODE },
			{ ID: CONTROL_PLANE_NODE },
		]);
		mocks.findServerById.mockResolvedValue(managerServer);
		mocks.findServersByOrganizationId.mockResolvedValue([managerServer]);

		await setupMonitoring("manager-server");

		expect(managerDocker.removeLegacyService).not.toHaveBeenCalled();
	});

	it("leaves the control plane's own node to the built-in monitoring service", async () => {
		const controlPlaneServer = {
			serverId: "control-plane-server",
			name: "haiku-0",
			organizationId: "org-id",
			metricsConfig: {},
		};
		mocks.getRemoteDocker.mockResolvedValue(controlPlaneDocker);
		mocks.findServerById.mockResolvedValue(controlPlaneServer);
		mocks.findServersByOrganizationId.mockResolvedValue([controlPlaneServer]);

		await setupMonitoring("control-plane-server");

		// a second agent on that node would race setupWebMonitoring for :4500
		expect(controlPlaneDocker.createService).not.toHaveBeenCalled();
		expect(controlPlaneDocker.removeLegacyService).not.toHaveBeenCalled();
	});

	it("pins control-plane monitoring to the control plane's own node", async () => {
		await setupWebMonitoring();

		expect(controlPlaneDocker.createService).toHaveBeenCalledWith(
			expect.objectContaining({
				Name: "dokploy-monitoring",
				TaskTemplate: expect.objectContaining({
					Placement: { Constraints: [`node.id==${CONTROL_PLANE_NODE}`] },
				}),
			}),
		);
	});
});
