import type { ComposeSpecification } from "@dokploy/server";
import {
	addSuffixToVolumesInServices,
	addVolumeToComposeFile,
	extractServiceVolumes,
	generateRandomHash,
	removeVolumeFromComposeFile,
	updateVolumeInComposeFile,
} from "@dokploy/server";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("Generate random hash with 8 characters", () => {
	const hash = generateRandomHash();

	expect(hash).toBeDefined();
	expect(hash.length).toBe(8);
});

const composeFile1 = `
version: "3.8"

services:
  db:
    image: postgres:latest
    volumes:
      - db_data:/var/lib/postgresql/data
`;

test("Add suffix to volumes declared directly in services", () => {
	const composeData = parse(composeFile1) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}

	const updatedComposeData = addSuffixToVolumesInServices(
		composeData.services,
		suffix,
	);
	const actualComposeData = { ...composeData, services: updatedComposeData };
	expect(actualComposeData.services?.db?.volumes).toContain(
		`db_data-${suffix}:/var/lib/postgresql/data`,
	);
});

const composeFileAccessMode = `
version: "3.8"

services:
  web:
    image: nginx:alpine
    volumes:
      - web_config:/etc/nginx/conf.d:ro
      - certs/sub:/etc/certs:Z
`;

test("Add suffix to volumes preserves access mode (:ro, :z, :Z)", () => {
	const composeData = parse(composeFileAccessMode) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}

	const updatedComposeData = addSuffixToVolumesInServices(
		composeData.services,
		suffix,
	);

	expect(updatedComposeData.web?.volumes).toContain(
		`web_config-${suffix}:/etc/nginx/conf.d:ro`,
	);
	expect(updatedComposeData.web?.volumes).toContain(
		`certs-${suffix}/sub:/etc/certs:Z`,
	);
});

const composeFileTypeVolume = `
version: "3.8"

services:
  db:
    image: postgres:latest
    volumes:
      - type: volume
        source: db-test
        target: /var/lib/postgresql/data

volumes:
  db-test:
    driver: local
`;

test("Add suffix to volumes declared directly in services (Case 2)", () => {
	const composeData = parse(composeFileTypeVolume) as ComposeSpecification;

	const suffix = generateRandomHash();

	if (!composeData.services) {
		return;
	}

	const updatedComposeData = addSuffixToVolumesInServices(
		composeData.services,
		suffix,
	);
	const actualComposeData = { ...composeData, services: updatedComposeData };

	expect(actualComposeData.services?.db?.volumes).toEqual([
		{
			type: "volume",
			source: `db-test-${suffix}`,
			target: "/var/lib/postgresql/data",
		},
	]);
});

test("Extract, add, and remove service volumes without mutating the compose source", () => {
	const composeData = parse(composeFileTypeVolume) as ComposeSpecification;

	expect(extractServiceVolumes(composeData)).toEqual([
		{
			serviceName: "db",
			type: "volume",
			source: "db-test",
			target: "/var/lib/postgresql/data",
		},
	]);

	const addedFile = addVolumeToComposeFile(
		composeFileTypeVolume,
		"db",
		"./backups:/var/lib/postgresql/backups",
	);
	const added = parse(addedFile) as ComposeSpecification;
	expect(added.services?.db?.volumes).toContain(
		"./backups:/var/lib/postgresql/backups",
	);

	const removedFile = removeVolumeFromComposeFile(
		addedFile,
		"db",
		"/var/lib/postgresql/data",
	);
	const removed = parse(removedFile) as ComposeSpecification;
	expect(extractServiceVolumes(removed)).toEqual([
		{
			serviceName: "db",
			type: "bind",
			source: "./backups",
			target: "/var/lib/postgresql/backups",
		},
	]);
});

test("Update service volumes preserves short and long syntax options", () => {
	const updatedShortSyntaxFile = updateVolumeInComposeFile(
		composeFileAccessMode,
		"web",
		"/etc/nginx/conf.d",
		"web-next",
		"/etc/nginx/templates",
	);
	const updatedShortSyntax = parse(
		updatedShortSyntaxFile,
	) as ComposeSpecification;
	expect(updatedShortSyntax.services?.web?.volumes).toContain(
		"web-next:/etc/nginx/templates:ro",
	);

	const longSyntaxFile = `
# preserve top-level comment
services:
  db:
    image: postgres:latest
    volumes:
      - type: volume
        source: db-data # preserve source comment
        target: /var/lib/postgresql/data
        read_only: true # preserve option comment
        volume:
          nocopy: true
`;
	const updatedLongSyntaxFile = updateVolumeInComposeFile(
		longSyntaxFile,
		"db",
		"/var/lib/postgresql/data",
		"db-next",
		"/var/lib/postgresql/next",
	);
	expect(updatedLongSyntaxFile).toContain("# preserve top-level comment");
	expect(updatedLongSyntaxFile).toContain("# preserve source comment");
	expect(updatedLongSyntaxFile).toContain("# preserve option comment");
	const updatedLongSyntax = parse(
		updatedLongSyntaxFile,
	) as ComposeSpecification;
	expect(updatedLongSyntax.services?.db?.volumes).toEqual([
		{
			type: "volume",
			source: "db-next",
			target: "/var/lib/postgresql/next",
			read_only: true,
			volume: { nocopy: true },
		},
	]);
});

test("Extract service volumes treats one-part short syntax as an anonymous volume", () => {
	const composeData = parse(`
services:
  web:
    image: nginx:alpine
    volumes:
      - /usr/share/nginx/html
`) as ComposeSpecification;

	expect(extractServiceVolumes(composeData)).toEqual([
		{
			serviceName: "web",
			type: "volume",
			source: "",
			target: "/usr/share/nginx/html",
		},
	]);
});
