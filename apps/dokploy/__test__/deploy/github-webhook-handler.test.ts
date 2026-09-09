import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sourceRevision = "89abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
	cloudMode: false,
	deploy: vi.fn(),
	applicationsFindFirst: vi.fn(),
	composeFindFirst: vi.fn(),
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
	and: vi.fn((...conditions: Array<{ field: string; value: unknown }>) => ({
		conditions,
	})),
	githubFindFirst: vi.fn(),
	applicationsFindMany: vi.fn(),
	composeFindMany: vi.fn(),
	queueAdd: vi.fn(),
	verify: vi.fn(),
	shouldDeploy: vi.fn(),
	createPreviewDeployment: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: mocks.eq,
	and: mocks.and,
}));

vi.mock("@/server/db/schema", () => ({
	applications: {
		sourceType: "application.sourceType",
		autoDeploy: "application.autoDeploy",
		triggerType: "application.triggerType",
		branch: "application.branch",
		repository: "application.repository",
		owner: "application.owner",
		githubId: "application.githubId",
		isPreviewDeploymentsActive: "application.isPreviewDeploymentsActive",
	},
	compose: {
		sourceType: "compose.sourceType",
		autoDeploy: "compose.autoDeploy",
		triggerType: "compose.triggerType",
		branch: "compose.branch",
		repository: "compose.repository",
		owner: "compose.owner",
		githubId: "compose.githubId",
	},
	github: {
		githubInstallationId: "github.githubInstallationId",
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			github: {
				findFirst: mocks.githubFindFirst,
			},
			applications: {
				findFirst: mocks.applicationsFindFirst,
				findMany: mocks.applicationsFindMany,
			},
			compose: {
				findFirst: mocks.composeFindFirst,
				findMany: mocks.composeFindMany,
			},
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	get IS_CLOUD() {
		return mocks.cloudMode;
	},
	shouldDeploy: mocks.shouldDeploy,
	checkUserRepositoryPermissions: vi.fn(),
	createPreviewDeployment: mocks.createPreviewDeployment,
	createSecurityBlockedComment: vi.fn(),
	findGithubById: vi.fn(),
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	findPreviewDeploymentsByPullRequestId: vi.fn(),
	getBitbucketHeaders: vi.fn(() => ({})),
	removePreviewDeployment: vi.fn(),
}));

vi.mock("@octokit/webhooks", () => ({
	Webhooks: vi.fn().mockImplementation(function Webhooks() {
		return {
			verify: mocks.verify,
		};
	}),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: mocks.queueAdd,
	},
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: mocks.deploy,
}));

import applicationHandler from "@/pages/api/deploy/[refreshToken]";
import composeHandler from "@/pages/api/deploy/compose/[refreshToken]";
import handler from "@/pages/api/deploy/github";

const getConditionValue = (
	where: { conditions?: Array<{ field: string; value: unknown }> } | undefined,
	field: string,
) => where?.conditions?.find((condition) => condition.field === field)?.value;

const createResponse = () => {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
	} as unknown as NextApiResponse & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	};

	res.status.mockImplementation(() => res);
	res.json.mockImplementation(() => res);

	return res;
};

const createPushRequest = (
	branch: string,
	owner: { login?: string; name?: string } = { login: "agentHits" },
) =>
	({
		headers: {
			"x-hub-signature-256": "sha256=test-signature",
			"x-github-event": "push",
		},
		body: {
			installation: {
				id: 12345,
			},
			ref: `refs/heads/${branch}`,
			after: sourceRevision,
			head_commit: {
				id: sourceRevision,
				message: "fix: trigger deployment",
			},
			commits: [
				{
					modified: ["src/index.ts"],
				},
			],
			repository: {
				name: "dokploy",
				full_name: "agentHits/dokploy",
				clone_url: "https://github.com/agentHits/dokploy.git",
				html_url: "https://github.com/agentHits/dokploy",
				owner,
			},
		},
	}) as unknown as NextApiRequest;

const createTagRequest = (tagName: string) => {
	const req = createPushRequest("main") as unknown as {
		body: { ref: string; head_commit: null };
	};

	req.body.ref = `refs/tags/${tagName}`;
	req.body.head_commit = null;

	return req as unknown as NextApiRequest;
};

describe("GitHub app webhook auto-deploy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cloudMode = false;
		mocks.deploy.mockResolvedValue(undefined);
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
		});
		mocks.verify.mockResolvedValue(true);
		mocks.shouldDeploy.mockReturnValue(true);
		mocks.composeFindMany.mockResolvedValue([]);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });

		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "push" &&
				getConditionValue(where, "application.branch") === "main" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								serverId: null,
								watchPaths: null,
							},
						]
					: [],
			);
		});
	});

	it("matches push events using repository owner name when available", async () => {
		const res = createResponse();

		await handler(
			createPushRequest("main", {
				login: "agentHits-login",
				name: "agentHits",
			}),
			res,
		);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application",
				sourceRevision,
				type: "deploy",
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "Deployed 1 apps" });
	});

	it("matches compose push events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockResolvedValue([]);
		mocks.composeFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "compose.sourceType") === "github" &&
				getConditionValue(where, "compose.autoDeploy") === true &&
				getConditionValue(where, "compose.triggerType") === "push" &&
				getConditionValue(where, "compose.branch") === "main" &&
				getConditionValue(where, "compose.repository") === "dokploy" &&
				getConditionValue(where, "compose.owner") === "agentHits" &&
				getConditionValue(where, "compose.githubId") === "github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								composeId: "compose-id",
								serverId: null,
								watchPaths: null,
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createPushRequest("main"), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.not.objectContaining({ sourceRevision }),
		);
		const composeJob = mocks.queueAdd.mock.calls[0]?.[0];
		expect(composeJob).toMatchObject({
			applicationType: "compose",
			composeId: "compose-id",
			type: "deploy",
		});
		expect(composeJob).not.toHaveProperty("sourceRevision");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "Deployed 1 apps" });
	});

	it("matches tag events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "tag" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								serverId: null,
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createTagRequest("v1.0.0"), res);

		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application",
				sourceRevision,
				titleLog: "Tag created: v1.0.0",
				type: "deploy",
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			message: "Deployed 1 apps based on tag v1.0.0",
		});
	});

	describe.each([false, true])("cloud mode %s", (cloudMode) => {
		it.each(["push", "tag"])(
			"routes %s application and compose deployments to their server",
			async (event) => {
				mocks.cloudMode = cloudMode;
				mocks.applicationsFindMany.mockResolvedValue([
					{ applicationId: "remote-app", serverId: "server-1" },
					{ applicationId: "local-app", serverId: null },
				]);
				mocks.composeFindMany.mockResolvedValue([
					{ composeId: "remote-compose", serverId: "server-2" },
					{ composeId: "local-compose", serverId: null },
				]);
				const res = createResponse();

				await handler(
					event === "push" ? createPushRequest("main") : createTagRequest("v1"),
					res,
				);

				const remoteDispatch = cloudMode ? mocks.deploy : mocks.queueAdd;
				expect(remoteDispatch).toHaveBeenCalledWith(
					expect.objectContaining({
						applicationId: "remote-app",
						serverId: "server-1",
						server: true,
					}),
				);
				expect(remoteDispatch).toHaveBeenCalledWith(
					expect.objectContaining({
						composeId: "remote-compose",
						serverId: "server-2",
						server: true,
					}),
				);
				expect(mocks.queueAdd).toHaveBeenCalledWith(
					expect.objectContaining({
						applicationId: "local-app",
						serverId: undefined,
						server: false,
					}),
				);
				expect(mocks.queueAdd).toHaveBeenCalledWith(
					expect.objectContaining({
						composeId: "local-compose",
						serverId: undefined,
						server: false,
					}),
				);
				expect(mocks.queueAdd).toHaveBeenCalledTimes(cloudMode ? 2 : 4);
				expect(mocks.deploy).toHaveBeenCalledTimes(cloudMode ? 2 : 0);
				expect(res.status).toHaveBeenCalledWith(200);
			},
		);
	});

	it("does not deploy when the pushed branch does not match", async () => {
		const res = createResponse();

		await handler(createPushRequest("feature"), res);

		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ message: "No apps to deploy" });
	});
});

describe("GitHub app webhook preview deployments", () => {
	const createApplication = (
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> => ({
		applicationId: "application-id",
		name: "my-app",
		serverId: null,
		previewLabels: [],
		previewLimit: 3,
		previewDeployments: [],
		previewRequireCollaboratorPermissions: false,
		...overrides,
	});

	const createPreviewDeployments = (total: number) =>
		Array.from({ length: total }, (_, index) => ({
			previewDeploymentId: `existing-preview-${index}`,
		}));

	const createPullRequestRequest = (action: string) =>
		({
			headers: {
				"x-hub-signature-256": "sha256=test-signature",
				"x-github-event": "pull_request",
			},
			body: {
				installation: {
					id: 12345,
				},
				action,
				pull_request: {
					id: 987,
					number: 42,
					title: "feat: add preview",
					html_url: "https://github.com/agentHits/dokploy/pull/42",
					labels: [],
					user: {
						login: "agentHits",
					},
					head: {
						ref: "feature",
						sha: "abc123",
					},
					base: {
						ref: "main",
					},
				},
				repository: {
					name: "dokploy",
					owner: {
						login: "agentHits",
					},
				},
			},
		}) as unknown as NextApiRequest;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cloudMode = false;
		mocks.deploy.mockResolvedValue(undefined);
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
		});
		mocks.verify.mockResolvedValue(true);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });
		mocks.createPreviewDeployment.mockResolvedValue({
			previewDeploymentId: "new-preview-id",
		});
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(undefined);
	});

	it.each([false, true])(
		"redeploys an existing remote preview at its limit (cloud %s)",
		async (cloudMode) => {
			mocks.cloudMode = cloudMode;
			mocks.applicationsFindMany.mockResolvedValue([
				createApplication({
					serverId: "server-preview",
					previewLimit: 2,
					previewDeployments: createPreviewDeployments(3),
				}),
			]);
			mocks.findPreviewDeploymentByApplicationId.mockResolvedValue({
				previewDeploymentId: "existing-preview-0",
			});
			const res = createResponse();

			await handler(createPullRequestRequest("synchronize"), res);

			expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
			expect(cloudMode ? mocks.deploy : mocks.queueAdd).toHaveBeenCalledWith(
				expect.objectContaining({
					applicationId: "application-id",
					applicationType: "application-preview",
					serverId: "server-preview",
					server: true,
					previewDeploymentId: "existing-preview-0",
					type: "deploy",
				}),
			);
			expect(res.status).toHaveBeenCalledWith(200);
		},
	);

	it("does not create a new preview once the limit is reached", async () => {
		mocks.applicationsFindMany.mockResolvedValue([
			createApplication({
				previewLimit: 2,
				previewDeployments: createPreviewDeployments(2),
			}),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createPreviewDeployment).not.toHaveBeenCalled();
		expect(mocks.queueAdd).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it("falls back to the default limit when none is configured", async () => {
		mocks.applicationsFindMany.mockResolvedValue([
			createApplication({
				previewLimit: null,
				previewDeployments: createPreviewDeployments(2),
			}),
		]);
		const res = createResponse();

		await handler(createPullRequestRequest("opened"), res);

		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-id",
				branch: "feature",
				pullRequestId: 987,
				pullRequestNumber: 42,
			}),
		);
		expect(mocks.queueAdd).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "application-id",
				applicationType: "application-preview",
				previewDeploymentId: "new-preview-id",
				type: "deploy",
			}),
		);
		expect(res.status).toHaveBeenCalledWith(200);
	});
});

describe.each([
	{
		applicationType: "application",
		handle: applicationHandler,
		find: mocks.applicationsFindFirst,
	},
	{
		applicationType: "compose",
		handle: composeHandler,
		find: mocks.composeFindFirst,
	},
])(
	"$applicationType token webhook routing",
	({ applicationType, handle, find }) => {
		beforeEach(() => {
			vi.clearAllMocks();
			mocks.shouldDeploy.mockReturnValue(true);
			mocks.queueAdd.mockResolvedValue({ id: "job-id" });
			mocks.deploy.mockResolvedValue(undefined);
		});

		it.each([
			{ cloudMode: false, serverId: "server-1" },
			{ cloudMode: true, serverId: "server-1" },
			{ cloudMode: false, serverId: null },
			{ cloudMode: true, serverId: null },
		])(
			"routes server $serverId (cloud $cloudMode)",
			async ({ cloudMode, serverId }) => {
				mocks.cloudMode = cloudMode;
				find.mockResolvedValue({
					applicationId: "application-id",
					composeId: "compose-id",
					autoDeploy: true,
					sourceType: "github",
					branch: "main",
					serverId,
				});
				const req = createPushRequest("main");
				req.query = { refreshToken: "test-token" };
				const res = createResponse();

				await handle(req, res);

				const directDeploy = cloudMode && serverId !== null;
				expect(
					directDeploy ? mocks.deploy : mocks.queueAdd,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						applicationType,
						serverId: serverId || undefined,
						server: serverId !== null,
					}),
				);
				expect(
					directDeploy ? mocks.queueAdd : mocks.deploy,
				).not.toHaveBeenCalled();
				expect(res.status).toHaveBeenCalledWith(200);
			},
		);
	},
);
