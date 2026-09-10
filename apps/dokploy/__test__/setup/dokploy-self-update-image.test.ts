import {
	DEFAULT_UPDATE_DATA,
	getDokployImageRepository,
	getUpdateData,
	reloadDockerResource,
} from "@dokploy/server/services/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: mocks.execAsyncRemote,
}));

vi.mock("@dokploy/server/setup/traefik-setup", () => ({
	initializeStandaloneTraefik: vi.fn(),
	initializeTraefikService: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => ({
	db: { query: { compose: { findMany: vi.fn() } } },
}));

/**
 * `docker service inspect dokploy` answers with the deployed image reference;
 * every other command in these paths is a resource-type probe.
 */
const respondWithDeployedImage = (image: string) => {
	mocks.execAsync.mockImplementation(async (command: string) =>
		command.includes("{{.Spec.TaskTemplate.ContainerSpec.Image}}")
			? { stdout: `${image}\n`, stderr: "" }
			: { stdout: "service\n", stderr: "" },
	);
};

const FORK_IMAGE =
	"ghcr.io/williamagh/dokploy@sha256:872ac501b3a271c29196b7bed323133e44174e751723acda5265a89d53d74605";
const UPSTREAM_IMAGE =
	"dokploy/dokploy:v0.30.5@sha256:beaab9d816750ea9524e47d6d1a9ba466d6c3442f9943fee8ac81a6d72f73103";

describe("Dokploy self-update image repository", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each([
		[FORK_IMAGE, "ghcr.io/williamagh/dokploy"],
		[UPSTREAM_IMAGE, "dokploy/dokploy"],
		["dokploy/dokploy", "dokploy/dokploy"],
		["dokploy/dokploy:canary", "dokploy/dokploy"],
		[
			"registry.example.com:5000/team/dokploy:v1",
			"registry.example.com:5000/team/dokploy",
		],
	])("reads %s as repository %s", async (image, expected) => {
		respondWithDeployedImage(image);

		await expect(getDokployImageRepository()).resolves.toBe(expected);
	});

	it("offers no update when the deployed image is not the upstream repository", async () => {
		respondWithDeployedImage(FORK_IMAGE);
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await expect(getUpdateData("0.30.5")).resolves.toEqual(DEFAULT_UPDATE_DATA);
		expect(fetchSpy).not.toHaveBeenCalled();

		fetchSpy.mockRestore();
	});

	it("reloads the dokploy service from the repository it is deployed from", async () => {
		respondWithDeployedImage(FORK_IMAGE);

		await reloadDockerResource("dokploy", undefined, "v0.30.5");

		expect(mocks.execAsync).toHaveBeenCalledWith(
			"docker service update --force --image ghcr.io/williamagh/dokploy:v0.30.5 dokploy",
		);
	});
});
