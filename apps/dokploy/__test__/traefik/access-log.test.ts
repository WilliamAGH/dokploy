import type { MainTraefikConfig } from "@dokploy/server";
import {
	getDefaultAccessLogConfig,
	getDefaultServerTraefikConfig,
	getDefaultTraefikConfig,
} from "@dokploy/server";
import { expect, test } from "vitest";
import { parse } from "yaml";

const expectSanitizedAccessLog = (config: MainTraefikConfig) => {
	expect(config.accessLog).toMatchObject({
		format: "json",
		fields: {
			headers: { defaultMode: "drop" },
			queryParameters: { defaultMode: "drop" },
		},
	});
};

test("default Traefik configurations write sanitized JSON access logs to stdout", () => {
	for (const getConfig of [
		getDefaultTraefikConfig,
		getDefaultServerTraefikConfig,
	]) {
		const config = parse(getConfig()) as MainTraefikConfig;

		expectSanitizedAccessLog(config);
		expect(config.accessLog?.filePath).toBeUndefined();
	}
});

test("local request logging preserves safe fields and restores stdout logging", () => {
	const config = parse(getDefaultTraefikConfig()) as MainTraefikConfig;

	config.accessLog = getDefaultAccessLogConfig({
		filePath: "/etc/dokploy/traefik/dynamic/access.log",
		bufferingSize: 100,
	});
	expectSanitizedAccessLog(config);
	expect(config.accessLog?.filePath).toBe(
		"/etc/dokploy/traefik/dynamic/access.log",
	);
	expect(config.accessLog?.bufferingSize).toBe(100);

	config.accessLog = getDefaultAccessLogConfig();
	expectSanitizedAccessLog(config);
	expect(config.accessLog?.filePath).toBeUndefined();
});
