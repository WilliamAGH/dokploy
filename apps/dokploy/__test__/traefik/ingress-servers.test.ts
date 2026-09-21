import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApplicationNested, Domain, FileConfig } from "@dokploy/server";
import { ingressTargets, manageDomain, removeDomain } from "@dokploy/server";
import { beforeEach, expect, test, vi } from "vitest";
import { parse } from "yaml";

const dynamicPath = fs.mkdtempSync(
	path.join(os.tmpdir(), "dokploy-ingress-servers-"),
);

// Each ingress server keeps its own copy of the file, written over SSH. Keep them
// in memory and key them by serverId so a write to one can never be mistaken for
// a write to another.
const remoteFiles = new Map<string, string>();

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@dokploy/server/constants")>();
	return {
		...actual,
		paths: () => ({
			...actual.paths(),
			DYNAMIC_TRAEFIK_PATH: dynamicPath,
		}),
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({ stdout: "", stderr: "" })),
	execAsyncRemote: vi.fn(async (serverId: string, command: string) => {
		const match = command.match(/^cat (\S+)/);
		if (match) {
			// A real host always has middlewares.yml, so an absent file reads as an
			// empty document, never as an empty string that parses to null.
			return { stdout: remoteFiles.get(`${serverId}:${match[1]}`) ?? "{}" };
		}
		const removed = command.match(/^rm -f (\S+)/);
		if (removed) {
			remoteFiles.delete(`${serverId}:${removed[1]}`);
		}
		return { stdout: "", stderr: "" };
	}),
	writeFileRemote: vi.fn(
		async (serverId: string, filePath: string, content: string) => {
			remoteFiles.set(`${serverId}:${filePath}`, content);
		},
	),
}));

const application = (ingressServerIds: string[]): ApplicationNested =>
	({
		appName: "harness-staging",
		serverId: "server-primary",
		redirects: [],
		security: [],
		swarmVipConnectionReuse: true,
		ingressServerIds,
	}) as unknown as ApplicationNested;

const domain = (uniqueConfigKey: number): Domain =>
	({
		applicationId: "application-id",
		certificateType: "none",
		createdAt: "",
		domainId: `domain-${uniqueConfigKey}`,
		host: `${uniqueConfigKey}.example.com`,
		https: false,
		path: null,
		port: 3000,
		customEntrypoint: null,
		serviceName: "",
		composeId: null,
		customCertResolver: null,
		domainType: "application",
		uniqueConfigKey,
		previewDeploymentId: null,
		internalPath: "/",
		stripPath: false,
		middlewares: null,
		forwardAuthEnabled: false,
		enabled: true,
	}) as Domain;

const routeFile = (serverId: string): FileConfig | undefined => {
	for (const [key, value] of remoteFiles) {
		if (key.startsWith(`${serverId}:`) && key.endsWith("harness-staging.yml")) {
			return parse(value) as FileConfig;
		}
	}
	return undefined;
};

beforeEach(() => {
	remoteFiles.clear();
});

test("the application's own server is the only target when no ingress server is set", () => {
	expect(ingressTargets(application([])).map((app) => app.serverId)).toEqual([
		"server-primary",
	]);
});

test("a duplicate and the application's own server are not extra targets", () => {
	const targets = ingressTargets(
		application(["server-a", "server-a", "server-primary"]),
	);
	expect(targets.map((app) => app.serverId)).toEqual([
		"server-primary",
		"server-a",
	]);
});

test("a domain is published to every ingress server, pointing at the same backend", async () => {
	await manageDomain(application(["server-a", "server-b"]), domain(1));

	for (const serverId of ["server-primary", "server-a", "server-b"]) {
		const config = routeFile(serverId);
		expect(
			config?.http?.routers?.["harness-staging-router-1"]?.rule,
			serverId,
		).toBe("Host(`1.example.com`)");
		expect(
			config?.http?.services?.["harness-staging-service-1"],
			serverId,
		).toMatchObject({
			loadBalancer: { servers: [{ url: "http://harness-staging:3000" }] },
		});
	}
});

test("removing a domain removes it from every ingress server", async () => {
	const app = application(["server-a"]);
	await manageDomain(app, domain(1));
	await manageDomain(app, domain(2));
	await removeDomain(app, 1);

	for (const serverId of ["server-primary", "server-a"]) {
		const config = routeFile(serverId);
		expect(config?.http?.routers?.["harness-staging-router-1"], serverId).toBe(
			undefined,
		);
		expect(
			config?.http?.routers?.["harness-staging-router-2"],
			serverId,
		).toBeDefined();
	}
});

test("removing the last domain deletes the file on every ingress server", async () => {
	const app = application(["server-a"]);
	await manageDomain(app, domain(1));
	await removeDomain(app, 1);

	expect(routeFile("server-primary")).toBe(undefined);
	expect(routeFile("server-a")).toBe(undefined);
});

test("a disabled domain gets no router on any ingress server", async () => {
	const app = application(["server-a"]);
	await manageDomain(app, { ...domain(1), enabled: false });

	// Removing a domain that was never written leaves an empty document rather
	// than no file, which is how the single-server path behaves too.
	for (const serverId of ["server-primary", "server-a"]) {
		expect(routeFile(serverId)?.http?.routers, serverId).toBe(undefined);
	}
});
