import { execFileSync } from "node:child_process";
import { TRAEFIK_CONTAINER_NAME_FILTER } from "@dokploy/server/constants";
import { reconnectServicesToTraefik } from "@dokploy/server/services/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: mocks.findMany,
			},
		},
	},
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

describe("reconnectServicesToTraefik", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([]);
	});

	it("does not execute an empty local command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik();

		expect(mocks.execAsync).not.toHaveBeenCalled();
	});

	it("does not execute an empty remote command when no isolated deployments exist", async () => {
		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments to the local Traefik network", async () => {
		mocks.findMany.mockResolvedValue([
			{ appName: "first-compose" },
			{ appName: "second-compose" },
		]);

		await reconnectServicesToTraefik();

		expect(mocks.execAsync).toHaveBeenCalledOnce();
		expect(mocks.execAsync).toHaveBeenCalledWith(
			`docker network connect first-compose $(docker ps --filter "${TRAEFIK_CONTAINER_NAME_FILTER}" -q) >/dev/null 2>&1\n` +
				`docker network connect second-compose $(docker ps --filter "${TRAEFIK_CONTAINER_NAME_FILTER}" -q) >/dev/null 2>&1\n`,
		);
		expect(mocks.execAsyncRemote).not.toHaveBeenCalled();
	});

	it("reconnects isolated deployments on a remote server", async () => {
		mocks.findMany.mockResolvedValue([{ appName: "remote-compose" }]);

		await reconnectServicesToTraefik("server-id");

		expect(mocks.execAsyncRemote).toHaveBeenCalledOnce();
		expect(mocks.execAsyncRemote).toHaveBeenCalledWith(
			"server-id",
			`docker network connect remote-compose $(docker ps --filter "${TRAEFIK_CONTAINER_NAME_FILTER}" -q) >/dev/null 2>&1\n`,
		);
		expect(mocks.execAsync).not.toHaveBeenCalled();
	});
});

describe("the Traefik container name filter", () => {
	// What docker receives after the shell expands the generated command's argument.
	const filterDockerReceives = async () => {
		mocks.findMany.mockResolvedValue([{ appName: "probe" }]);
		await reconnectServicesToTraefik();
		const command = String(mocks.execAsync.mock.calls.at(-1)?.[0]);
		const quoted = command.match(/--filter ("[^"]*")/)?.[1];
		expect(quoted).toBeDefined();
		const argument = execFileSync("sh", ["-c", `printf %s ${quoted}`], {
			encoding: "utf8",
		});
		return new RegExp(argument.replace(/^name=/, ""));
	};

	it("matches the standalone container and its Swarm service task only", async () => {
		const name = await filterDockerReceives();
		expect(name.test("dokploy-traefik")).toBe(true);
		expect(name.test("dokploy-traefik.1.abc")).toBe(true);
		expect(name.test("dokploy-traefik-old")).toBe(false);
		expect(name.test("dokploy-traefik.1.abc-old")).toBe(false);
	});
});
