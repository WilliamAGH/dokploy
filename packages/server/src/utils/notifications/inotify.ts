import { and, eq, isNotNull } from "drizzle-orm";
import { scheduleJob, scheduledJobs } from "node-schedule";
import { db } from "../../db";
import { server } from "../../db/schema";
import { findOwner } from "../../services/admin";
import { getInotifyUsage } from "../../services/inotify";
import { getWebServerSettings } from "../../services/web-server-settings";
import { sendServerThresholdNotifications } from "./server-threshold";

const lastAlerts = new Map<string, Map<number, number>>();
let checking = false;

export const checkInotifyThresholds = async () => {
	if (checking) return;
	checking = true;
	try {
		const servers = await db.query.server.findMany({
			where: and(
				eq(server.serverStatus, "active"),
				eq(server.serverType, "deploy"),
				isNotNull(server.sshKeyId),
			),
			columns: { serverId: true, organizationId: true, name: true },
		});
		const targets: Array<{
			serverId?: string;
			organizationId: string;
			name: string;
		}> = [...servers];
		try {
			const settings = await getWebServerSettings();
			const organizationId =
				settings.metricsConfig?.server.organizationId ??
				(await findOwner()).organizationId;
			targets.push({ organizationId, name: "Dokploy" });
		} catch {
			console.error(
				"Could not resolve the Dokploy organization for inotify alerts.",
			);
		}
		const active = new Set(targets.map((target) => target.serverId ?? "local"));
		for (const key of lastAlerts.keys())
			if (!active.has(key)) lastAlerts.delete(key);
		await Promise.allSettled(
			targets.map(async (target) => {
				const key = target.serverId ?? "local";
				const usage = await getInotifyUsage(target.serverId);
				if (usage.error || usage.maxInstances <= 0) {
					console.error(`Inotify usage unavailable for ${key}.`);
					return;
				}
				const alerts = lastAlerts.get(key) ?? new Map<number, number>();
				lastAlerts.set(key, alerts);
				const exceeded = usage.users.filter(
					(user) => user.currentInstances >= usage.maxInstances,
				);
				for (const uid of alerts.keys())
					if (!exceeded.some((user) => user.uid === uid)) alerts.delete(uid);
				for (const user of exceeded) {
					const now = Date.now();
					const previous = alerts.get(user.uid);
					if (previous !== undefined && now - previous < 30 * 60_000) continue;
					await sendServerThresholdNotifications(target.organizationId, {
						Type: "Inotify",
						Value: (100 * user.currentInstances) / usage.maxInstances,
						Threshold: 100,
						Message: `Host UID ${user.uid} has ${user.currentInstances} inotify descriptor references (limit ${usage.maxInstances}). Shared descriptors may overcount. At the limit, new file watchers can fail, disrupting log collection or app startup. Existing watchers usually keep running.`,
						Timestamp: new Date(now).toISOString(),
						Token: "",
						ServerName: target.name,
					});
					alerts.set(user.uid, now);
				}
			}),
		);
	} finally {
		checking = false;
	}
};

export const initInotifyThresholds = () => {
	if (scheduledJobs["inotify-thresholds"]) return;
	scheduleJob("inotify-thresholds", "* * * * *", () => {
		void checkInotifyThresholds().catch(() =>
			console.error("Inotify threshold check failed."),
		);
	});
};
