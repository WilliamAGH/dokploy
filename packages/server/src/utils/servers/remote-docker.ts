import { docker } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import Dockerode from "dockerode";
import { PooledDockerAgent } from "./ssh-connection";

export const getRemoteDocker = async (serverId?: string | null) => {
	if (!serverId) return docker;
	const server = await findServerById(serverId);
	if (!server.sshKeyId) return docker;
	if (!server.sshKey) throw new Error("No SSH key available for this server");
	// Requests ride the server's pooled SSH connection; host and port only fill
	// the HTTP request line, since the agent supplies the connection. Dockerode
	// hands these options to docker-modem, which reads `agent`; Dockerode's own
	// option type omits it.
	const options = {
		protocol: "http" as const,
		host: "localhost",
		port: 2375,
		agent: new PooledDockerAgent({
			serverId,
			ipAddress: server.ipAddress,
			port: server.port,
			username: server.username,
			privateKey: server.sshKey.privateKey,
		}),
	};
	return new Dockerode(options);
};
