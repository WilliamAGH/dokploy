import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
	registries: [] as { registryId: string; registryName: string }[],
}));

vi.mock("@/utils/api", () => {
	const service = {
		one: {
			useQuery: () => ({
				data: {
					command: "",
					replicas: 1,
					registryId: "registry-a",
					swarmVipConnectionReuse: true,
				},
				refetch: vi.fn(),
			}),
		},
		update: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
	};
	return {
		api: {
			application: service,
			postgres: service,
			registry: { all: { useQuery: () => ({ data: fixtures.registries }) } },
		},
	};
});

vi.mock(
	"@/components/dashboard/application/advanced/cluster/modify-swarm-settings",
	() => ({ AddSwarmSettings: () => null }),
);

import { ShowClusterSettings } from "../../components/dashboard/application/advanced/cluster/show-cluster-settings";

describe("backend connection reuse visibility", () => {
	it.each([false, true])(
		"does not depend on registries being present: %s",
		(hasRegistry) => {
			fixtures.registries = hasRegistry
				? [{ registryId: "registry-a", registryName: "Registry A" }]
				: [];
			const html = renderToStaticMarkup(
				createElement(ShowClusterSettings, {
					id: "application-a",
					type: "application",
				}),
			);
			expect(html).toContain("Reuse backend connections");
			expect(html).toContain('role="switch"');
			if (!hasRegistry) {
				expect(html).toContain("configure at least");
			}
		},
	);

	it("does not expose an application option for database services", () => {
		const html = renderToStaticMarkup(
			createElement(ShowClusterSettings, {
				id: "postgres-a",
				type: "postgres",
			}),
		);
		expect(html).not.toContain("Reuse backend connections");
	});
});
