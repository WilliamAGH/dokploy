import type { Registry } from "@dokploy/server";
import { getRegistryTag, uploadImageRemoteCommand } from "@dokploy/server";
import { quote } from "shell-quote";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	findAllRegistryMock,
	findRegistryMock,
	createRollbackMock,
	confirmRollbackMock,
	discardRollbackMock,
	execAsyncMock,
	execAsyncRemoteMock,
	serviceInspectMock,
	getRemoteDockerMock,
} = vi.hoisted(() => ({
	findAllRegistryMock: vi.fn(),
	findRegistryMock: vi.fn(),
	createRollbackMock: vi.fn(),
	confirmRollbackMock: vi.fn(),
	discardRollbackMock: vi.fn(),
	execAsyncMock: vi.fn(),
	execAsyncRemoteMock: vi.fn(),
	serviceInspectMock: vi.fn(),
	getRemoteDockerMock: vi.fn(),
}));

vi.mock("@dokploy/server/services/registry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@dokploy/server/services/registry")
	>()),
	findAllRegistryByOrganizationId: findAllRegistryMock,
	findRegistryByIdWithCredentials: findRegistryMock,
}));
vi.mock("@dokploy/server/services/rollbacks", () => ({
	confirmRollback: confirmRollbackMock,
	createRollback: createRollbackMock,
	discardRollback: discardRollbackMock,
}));
vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: execAsyncMock,
	execAsyncRemote: execAsyncRemoteMock,
}));
vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

beforeEach(() => {
	findAllRegistryMock.mockReset();
	findAllRegistryMock.mockResolvedValue([]);
	findRegistryMock.mockReset();
	createRollbackMock.mockReset();
	confirmRollbackMock.mockReset();
	confirmRollbackMock.mockResolvedValue(undefined);
	discardRollbackMock.mockReset();
	execAsyncMock.mockReset();
	execAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
	execAsyncRemoteMock.mockReset();
	execAsyncRemoteMock.mockResolvedValue({ stdout: "", stderr: "" });
	serviceInspectMock.mockReset();
	getRemoteDockerMock.mockReset();
	getRemoteDockerMock.mockResolvedValue({
		getService: vi.fn(() => ({ inspect: serviceInspectMock })),
	});
});

const getArchiveCommand = () =>
	execAsyncRemoteMock.mock.calls.at(-1)?.[1] ??
	execAsyncMock.mock.calls.at(-1)?.[0] ??
	"";

describe("getRegistryTag", () => {
	// Helper to create a mock registry
	const createMockRegistry = (overrides: Partial<Registry> = {}): Registry => {
		return {
			registryId: "test-registry-id",
			registryName: "Test Registry",
			username: "myuser",
			password: "test-password",
			registryUrl: "docker.io",
			registryType: "cloud",
			imagePrefix: null,
			createdAt: new Date().toISOString(),
			organizationId: "test-org-id",
			...overrides,
		};
	};

	describe("with username (no imagePrefix)", () => {
		it("should handle simple image name without tag", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("docker.io/myuser/nginx");
		});

		it("should handle image name with tag", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "nginx:latest");
			expect(result).toBe("docker.io/myuser/nginx:latest");
		});

		it("should handle image name with username already present (no duplication)", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "myuser/myprivaterepo");
			// Should not duplicate username
			expect(result).toBe("docker.io/myuser/myprivaterepo");
		});

		it("should handle image name with username and tag already present", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "myuser/myprivaterepo:latest");
			// Should not duplicate username
			expect(result).toBe("docker.io/myuser/myprivaterepo:latest");
		});

		it("should handle complex image name with username", () => {
			const registry = createMockRegistry({ username: "siumauricio" });
			const result = getRegistryTag(
				registry,
				"siumauricio/app-parse-multi-byte-port-e32uh7",
			);
			// Should not duplicate username
			expect(result).toBe(
				"docker.io/siumauricio/app-parse-multi-byte-port-e32uh7",
			);
		});

		it("should handle image name with different username (should not duplicate)", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "otheruser/myprivaterepo");
			expect(result).toBe("docker.io/myuser/myprivaterepo");
		});

		it("should handle image name with full registry URL (no username)", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "docker.io/nginx");
			// Should add username since imageName doesn't have one
			expect(result).toBe("docker.io/myuser/nginx");
		});

		it("should handle image name with custom registry URL and username", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "ghcr.io/myuser/repo");
			// Should not duplicate username even if registry URL is different
			expect(result).toBe("docker.io/myuser/repo");
		});

		it("should handle image name with custom registry URL (different username)", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "ghcr.io/otheruser/repo");
			// Should use registry username, not the one in imageName
			expect(result).toBe("docker.io/myuser/repo");
		});
	});

	describe("with imagePrefix", () => {
		it("should use imagePrefix instead of username", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("docker.io/myorg/nginx");
		});

		it("should use imagePrefix with image tag", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
			});
			const result = getRegistryTag(registry, "nginx:latest");
			expect(result).toBe("docker.io/myorg/nginx:latest");
		});

		it("should handle imagePrefix with username already in image name", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
			});
			const result = getRegistryTag(registry, "myuser/myprivaterepo");
			expect(result).toBe("docker.io/myorg/myprivaterepo");
		});

		it("should handle imagePrefix matching image name prefix", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
			});
			const result = getRegistryTag(registry, "myorg/myprivaterepo");
			// Should not duplicate prefix
			expect(result).toBe("docker.io/myorg/myprivaterepo");
		});
	});

	describe("without registryUrl", () => {
		it("should work without registryUrl", () => {
			const registry = createMockRegistry({
				username: "myuser",
				registryUrl: "",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("myuser/nginx");
		});

		it("should work without registryUrl with imagePrefix", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
				registryUrl: "",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("myorg/nginx");
		});

		it("should handle username already present without registryUrl", () => {
			const registry = createMockRegistry({
				username: "myuser",
				registryUrl: "",
			});
			const result = getRegistryTag(registry, "myuser/myprivaterepo");
			// Should not duplicate username
			expect(result).toBe("myuser/myprivaterepo");
		});
	});

	describe("with custom registryUrl", () => {
		it("should handle custom registry URL", () => {
			const registry = createMockRegistry({
				username: "myuser",
				registryUrl: "ghcr.io",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("ghcr.io/myuser/nginx");
		});

		it("should handle custom registry URL with imagePrefix", () => {
			const registry = createMockRegistry({
				username: "myuser",
				imagePrefix: "myorg",
				registryUrl: "ghcr.io",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("ghcr.io/myorg/nginx");
		});

		it("should handle custom registry URL with username already present", () => {
			const registry = createMockRegistry({
				username: "myuser",
				registryUrl: "ghcr.io",
			});
			const result = getRegistryTag(registry, "myuser/myprivaterepo");
			// Should not duplicate username
			expect(result).toBe("ghcr.io/myuser/myprivaterepo");
		});
	});

	describe("edge cases", () => {
		it("should handle empty image name", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "");
			expect(result).toBe("docker.io/myuser/");
		});

		it("should handle image name with multiple slashes", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "org/suborg/repo");
			expect(result).toBe("docker.io/myuser/repo");
		});

		it("should handle image name with username at different position", () => {
			const registry = createMockRegistry({ username: "myuser" });
			const result = getRegistryTag(registry, "org/myuser/repo");
			expect(result).toBe("docker.io/myuser/repo");
		});
	});

	describe("special characters in username", () => {
		it("should handle Harbor robot account username with $ (e.g. robot$library+dokploy)", () => {
			const registry = createMockRegistry({
				username: "robot$library+dokploy",
			});
			const result = getRegistryTag(registry, "nginx");
			expect(result).toBe("docker.io/robot$library+dokploy/nginx");
		});

		it("should handle username with $ and other special characters", () => {
			const registry = createMockRegistry({
				username: "robot$test+app",
			});
			const result = getRegistryTag(registry, "myapp:latest");
			expect(result).toBe("docker.io/robot$test+app/myapp:latest");
		});

		it("should handle username with multiple $ symbols", () => {
			const registry = createMockRegistry({
				username: "user$name$test",
			});
			const result = getRegistryTag(registry, "app");
			expect(result).toBe("docker.io/user$name$test/app");
		});

		it("should handle username with + and - symbols", () => {
			const registry = createMockRegistry({
				username: "robot+test-user",
			});
			const result = getRegistryTag(registry, "nginx:latest");
			expect(result).toBe("docker.io/robot+test-user/nginx:latest");
		});
	});
});

it("uses immutable Docker source images without retagging them", async () => {
	const command = await uploadImageRemoteCommand({
		sourceType: "docker",
		dockerImage: `registry.example.com/app@sha256:${"a".repeat(64)}`,
		registry: { registryId: "unused-for-immutable-source" },
	} as never);

	expect(command).toBe("");
	expect(findRegistryMock).not.toHaveBeenCalled();
});

it("publishes the live immutable Docker image as the rollback alias", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock.mockResolvedValueOnce({
		registryId: "rollback-registry",
		registryUrl: "rollback.example.com",
		registryType: "cloud",
		imagePrefix: "team",
		username: "user",
		password: "password",
	});
	findRegistryMock.mockResolvedValueOnce({
		registryId: "source-registry",
		registryUrl: "source.example.com",
		registryType: "cloud",
		imagePrefix: "source-team",
		username: "source-user",
		password: "source-password",
	});
	const candidateImage = `source.example.com/app@sha256:${"a".repeat(64)}`;
	const baselineImage = `source.example.com/app@sha256:${"b".repeat(64)}`;
	const rollbackContext = {
		dockerImage: candidateImage,
		env: "TOKEN=${{vault.provider.TOKEN}}",
	} as never;
	serviceInspectMock.mockResolvedValue({
		Spec: {
			TaskTemplate: {
				ContainerSpec: {
					Image: baselineImage,
					Labels: { "otel.service.version": "baseline" },
				},
			},
		},
	});
	await uploadImageRemoteCommand(
		{
			applicationId: "application-id",
			appName: "app",
			sourceType: "docker",
			dockerImage: candidateImage,
			registry: { registryId: "unused-for-immutable-source" },
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			serverId: "server-id",
		} as never,
		"deployment-id",
		rollbackContext,
	);
	const command = getArchiveCommand();

	expect(createRollbackMock).toHaveBeenCalledWith(
		expect.objectContaining({
			appName: "app",
			deploymentId: "deployment-id",
			fullContext: rollbackContext,
			rollbackSource: {
				authConfig: {
					password: "source-password",
					serveraddress: "source.example.com",
					username: "source-user",
				},
				image: baselineImage,
				labels: { "otel.service.version": "baseline" },
			},
		}),
	);
	expect(command).toContain("Enabled Rollback Registry");
	const pull = `docker pull ${quote([baselineImage])}`;
	const pullIndex = command.indexOf(pull);
	expect(pullIndex).toBeGreaterThan(-1);
	expect(command.indexOf("source.example.com")).toBeLessThan(pullIndex);
	expect(command.lastIndexOf("rollback.example.com")).toBeGreaterThan(
		pullIndex,
	);
	expect(command).toContain("docker buildx imagetools create");
	expect(command).toContain("b".repeat(64));
	expect(command).not.toContain("a".repeat(64));
	expect(confirmRollbackMock).toHaveBeenCalledWith(
		"rollback-id",
		"deployment-id",
	);
});

it("archives the live predecessor instead of a mutable Docker candidate tag", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock.mockResolvedValue({
		registryId: "rollback-registry",
		registryUrl: "registry.example.com",
		registryType: "cloud",
		imagePrefix: "team",
		username: "user",
		password: "password",
	});
	const baselineImage = `registry.example.com/app@sha256:${"b".repeat(64)}`;
	serviceInspectMock.mockResolvedValue({
		Spec: { TaskTemplate: { ContainerSpec: { Image: baselineImage } } },
	});

	await uploadImageRemoteCommand(
		{
			appName: "app",
			dockerImage: "registry.example.com/app:next",
			environment: { project: { organizationId: "organization-id" } },
			registry: { registryId: "candidate-registry" },
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			sourceType: "docker",
		} as never,
		"deployment-id",
	);

	const command = getArchiveCommand();
	expect(command).toContain(quote([baselineImage]));
	expect(command).not.toContain("app:next");
	expect(createRollbackMock).toHaveBeenCalledWith(
		expect.objectContaining({
			rollbackSource: expect.objectContaining({ image: baselineImage }),
		}),
	);
});

it("uses rollback-storage credentials when the predecessor came from it", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock
		.mockResolvedValueOnce({
			registryId: "rollback-registry",
			registryUrl: "rollback.example.com",
			registryType: "cloud",
			imagePrefix: "team",
			username: "rollback-user",
			password: "rollback-password",
		})
		.mockResolvedValueOnce({
			registryId: "candidate-registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			imagePrefix: "new-team",
			username: "candidate-user",
			password: "candidate-password",
		});
	const baselineImage = `rollback.example.com/app@sha256:${"b".repeat(64)}`;
	serviceInspectMock.mockResolvedValue({
		Spec: { TaskTemplate: { ContainerSpec: { Image: baselineImage } } },
	});

	await uploadImageRemoteCommand(
		{
			appName: "app",
			dockerImage: `candidate.example.com/app@sha256:${"a".repeat(64)}`,
			registry: { registryId: "candidate-registry" },
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			serverId: "server-id",
			sourceType: "docker",
		} as never,
		"deployment-id",
	);
	const command = getArchiveCommand();

	const pullIndex = command.indexOf(`docker pull ${quote([baselineImage])}`);
	expect(command.indexOf("rollback.example.com")).toBeLessThan(pullIndex);
	expect(command).not.toContain("candidate.example.com");
	expect(createRollbackMock).toHaveBeenCalledWith(
		expect.objectContaining({
			rollbackSource: expect.objectContaining({
				authConfig: expect.objectContaining({
					serveraddress: "rollback.example.com",
				}),
			}),
		}),
	);
});

it("rejects distinct accounts on one source and destination registry host", async () => {
	findRegistryMock
		.mockResolvedValueOnce({
			registryId: "rollback-registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			imagePrefix: "rollback-team",
			username: "rollback-user",
			password: "rollback-password",
		})
		.mockResolvedValueOnce({
			registryId: "source-registry",
			registryUrl: "registry.example.com",
			registryType: "cloud",
			imagePrefix: "source-team",
			username: "source-user",
			password: "source-password",
		});
	serviceInspectMock.mockResolvedValue({
		Spec: {
			TaskTemplate: {
				ContainerSpec: {
					Image: `registry.example.com/source-team/app@sha256:${"b".repeat(64)}`,
				},
			},
		},
	});

	await expect(
		uploadImageRemoteCommand(
			{
				appName: "app",
				dockerImage: `registry.example.com/source-team/app@sha256:${"a".repeat(64)}`,
				registry: { registryId: "source-registry" },
				rollbackActive: true,
				rollbackRegistry: { registryId: "rollback-registry" },
				sourceType: "docker",
			} as never,
			"deployment-id",
		),
	).rejects.toThrow(
		"Source and rollback repositories on one registry host require the same credentials",
	);
	expect(createRollbackMock).not.toHaveBeenCalled();
});

it("recognizes Docker Hub shorthand when selecting source credentials", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock
		.mockResolvedValueOnce({
			registryId: "rollback-registry",
			registryUrl: "index.docker.io",
			registryType: "cloud",
			imagePrefix: "team",
			username: "rollback-user",
			password: "rollback-password",
		})
		.mockResolvedValueOnce({
			registryId: "candidate-registry",
			registryUrl: "candidate.example.com",
			registryType: "cloud",
			imagePrefix: "team",
			username: "candidate-user",
			password: "candidate-password",
		});
	const baselineImage = `team/private@sha256:${"b".repeat(64)}`;
	serviceInspectMock.mockResolvedValue({
		Spec: { TaskTemplate: { ContainerSpec: { Image: baselineImage } } },
	});

	await uploadImageRemoteCommand(
		{
			appName: "app",
			dockerImage: `candidate.example.com/app@sha256:${"a".repeat(64)}`,
			registry: { registryId: "candidate-registry" },
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			sourceType: "docker",
		} as never,
		"deployment-id",
	);
	const command = getArchiveCommand();

	const pullIndex = command.indexOf(`docker pull ${quote([baselineImage])}`);
	expect(command.indexOf("index.docker.io")).toBeLessThan(pullIndex);
	expect(createRollbackMock).toHaveBeenCalledWith(
		expect.objectContaining({
			rollbackSource: expect.objectContaining({
				authConfig: expect.objectContaining({
					serveraddress: "index.docker.io",
				}),
			}),
		}),
	);
});

it("finds predecessor credentials in the organization registry inventory", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock
		.mockResolvedValueOnce({
			registryId: "rollback-registry",
			registryUrl: "rollback.example.com",
			registryType: "cloud",
			imagePrefix: "team",
			username: "rollback-user",
			password: "rollback-password",
		})
		.mockResolvedValueOnce({
			registryId: "candidate-registry",
			registryUrl: "candidate.example.com",
			registryType: "cloud",
			imagePrefix: "team",
			username: "candidate-user",
			password: "candidate-password",
		});
	findAllRegistryMock.mockResolvedValue([
		{
			imagePrefix: "old-team",
			registryUrl: "registry.example.com",
			username: "baseline-user",
			password: "baseline-password",
		},
	]);
	const baselineImage = `registry.example.com/old-team/app@sha256:${"b".repeat(64)}`;
	serviceInspectMock.mockResolvedValue({
		Spec: { TaskTemplate: { ContainerSpec: { Image: baselineImage } } },
	});

	await uploadImageRemoteCommand(
		{
			appName: "app",
			dockerImage: `registry.example.com/new-team/app@sha256:${"a".repeat(64)}`,
			environment: { project: { organizationId: "organization-id" } },
			registry: { registryId: "candidate-registry" },
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			sourceType: "docker",
		} as never,
		"deployment-id",
	);
	const command = getArchiveCommand();

	expect(findAllRegistryMock).toHaveBeenCalledWith("organization-id");
	expect(command.indexOf("registry.example.com")).toBeLessThan(
		command.indexOf(`docker pull ${quote([baselineImage])}`),
	);
	expect(createRollbackMock).toHaveBeenCalledWith(
		expect.objectContaining({
			rollbackSource: expect.objectContaining({
				authConfig: expect.objectContaining({
					serveraddress: "registry.example.com",
				}),
			}),
		}),
	);
});

it("discards a rollback record when archival publication fails", async () => {
	createRollbackMock.mockResolvedValue({
		image: "app:v1",
		rollbackId: "rollback-id",
	});
	findRegistryMock.mockResolvedValue({
		registryId: "rollback-registry",
		registryUrl: "rollback.example.com",
		registryType: "cloud",
		imagePrefix: "team",
		username: "rollback-user",
		password: "rollback-password",
	});
	serviceInspectMock.mockResolvedValue({
		Spec: {
			TaskTemplate: {
				ContainerSpec: {
					Image: `rollback.example.com/app@sha256:${"b".repeat(64)}`,
				},
			},
		},
	});
	execAsyncRemoteMock.mockRejectedValue(new Error("archive failed"));

	await expect(
		uploadImageRemoteCommand(
			{
				appName: "app",
				dockerImage: `candidate.example.com/app@sha256:${"a".repeat(64)}`,
				registry: { registryId: "candidate-registry" },
				rollbackActive: true,
				rollbackRegistry: { registryId: "rollback-registry" },
				serverId: "server-id",
				sourceType: "docker",
			} as never,
			"deployment-id",
		),
	).rejects.toThrow("archive failed");
	expect(discardRollbackMock).toHaveBeenCalledWith(
		"rollback-id",
		"deployment-id",
	);
});

it("does not create a rollback record before the first immutable Docker deploy", async () => {
	serviceInspectMock.mockRejectedValue({ statusCode: 404 });

	const command = await uploadImageRemoteCommand(
		{
			applicationId: "application-id",
			appName: "app",
			sourceType: "docker",
			dockerImage: `registry.example.com/app@sha256:${"a".repeat(64)}`,
			rollbackActive: true,
			rollbackRegistry: { registryId: "rollback-registry" },
			serverId: "server-id",
		} as never,
		"deployment-id",
	);

	expect(command).toBe("");
	expect(createRollbackMock).not.toHaveBeenCalled();
	expect(findRegistryMock).not.toHaveBeenCalled();
});

it("does not hide immutable Docker baseline inspection failures", async () => {
	serviceInspectMock.mockRejectedValue(new Error("manager unavailable"));

	await expect(
		uploadImageRemoteCommand(
			{
				applicationId: "application-id",
				appName: "app",
				sourceType: "docker",
				dockerImage: `registry.example.com/app@sha256:${"a".repeat(64)}`,
				rollbackActive: true,
				rollbackRegistry: { registryId: "rollback-registry" },
				serverId: "server-id",
			} as never,
			"deployment-id",
		),
	).rejects.toThrow("manager unavailable");
	expect(createRollbackMock).not.toHaveBeenCalled();
});
