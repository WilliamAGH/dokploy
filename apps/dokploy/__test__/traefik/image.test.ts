import { afterEach, describe, expect, it, vi } from "vitest";

describe("Traefik image configuration", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("accepts a full immutable image reference", {
		timeout: 15_000,
	}, async () => {
		const image = "registry.example.com/traefik@sha256:deadbeef";
		vi.stubEnv("TRAEFIK_IMAGE", image);
		vi.resetModules();

		const { TRAEFIK_IMAGE } = await import(
			"@dokploy/server/setup/traefik-setup"
		);

		expect(TRAEFIK_IMAGE).toBe(image);
	});

	it("recognizes only the code-owned readiness image digest", async () => {
		vi.stubEnv(
			"TRAEFIK_IMAGE",
			"registry.example.com/traefik@sha256:arbitrary",
		);
		vi.resetModules();

		const { isSwarmReadinessTraefikImage, SWARM_READINESS_TRAEFIK_IMAGE } =
			await import("@dokploy/server/setup/traefik-setup");

		expect(isSwarmReadinessTraefikImage()).toBe(false);
		expect(isSwarmReadinessTraefikImage(SWARM_READINESS_TRAEFIK_IMAGE)).toBe(
			true,
		);
	});
});
