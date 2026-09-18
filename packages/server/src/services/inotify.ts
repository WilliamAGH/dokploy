import { randomUUID } from "node:crypto";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

export interface InotifyUsage {
	maxWatches: number;
	maxInstances: number;
	maxQueuedEvents: number;
	persisted: boolean | null;
	users: Array<{
		uid: number;
		username: string | null;
		currentInstances: number;
	}>;
	defaultUid: number;
	error?: string;
}

// Exported for the fixture-driven scan test; the container passes no argument
// and the scan then reads the bind-mounted host /proc.
export const inotifyScanScript = String.raw`
set -eu
root=/host/proc
[ $# -eq 0 ] || root=$1
printf 'limits\t%s\t%s\t%s\n' "$(cat "$root/sys/fs/inotify/max_user_watches")" "$(cat "$root/sys/fs/inotify/max_user_instances")" "$(cat "$root/sys/fs/inotify/max_queued_events")"

# An inotify descriptor's fdinfo holds its offset, flags and mount id, then one
# line per watch in watch-descriptor order. Bounded so a heavily watched
# descriptor cannot stall the scan.
fingerprint() {
  fp= fpn=0
  { while [ "$fpn" -lt 64 ] && IFS= read -r fpline; do
      fp=$fp$fpline'|'
      fpn=$((fpn + 1))
    done < "$1"; } 2>/dev/null || return 1
  [ -n "$fp" ]
}

# fs.inotify.max_user_instances is charged per inotify instance, not per
# descriptor referring to one. fork() hands the child the same instance under
# the same descriptor number, so an exact fdinfo match against the parent's
# descriptor of that number means the parent already reported this instance.
inherited() {
  parent=$root/$2
  link=$(readlink "$parent/fd/$3" 2>/dev/null || true)
  case "$link" in anon_inode:inotify|'anon_inode:[inotify]') ;; *) return 1 ;; esac
  fingerprint "$1/fdinfo/$3" || return 1
  own=$fp
  fingerprint "$parent/fdinfo/$3" || return 1
  [ "$own" = "$fp" ]
}

for process in "$root"/[0-9]*; do
  [ -d "$process" ] || continue
  uid= name= ppid=0
  if ! status=$(cat "$process/status" 2>/dev/null); then
    [ ! -d "$process" ] && continue
    exit 2
  fi
  while read -r key value rest; do
    case "$key" in
      Name:) name=$value ;;
      PPid:) ppid=$value ;;
      Uid:) uid=$value; break ;;
    esac
  done <<EOF
$status
EOF
  case "$uid" in ''|*[!0-9]*) exit 2 ;; esac
  case "$ppid" in ''|*[!0-9]*) exit 2 ;; esac
  [ "$name" != dockerd ] || printf 'daemon\t%s\n' "$uid"
  if ! descriptors=$(ls -ln "$process/fd" 2>/dev/null); then
    [ ! -d "$process" ] && continue
    # A descriptor may close while ls is reading it; retry this PID once.
    descriptors=$(ls -ln "$process/fd" 2>/dev/null) || {
      [ ! -d "$process" ] && continue
      exit 2
    }
  fi
  count=0
  while read -r descriptor; do
    case "$descriptor" in
      l*' -> anon_inode:inotify'|l*' -> anon_inode:[inotify]') ;;
      *) continue ;;
    esac
    # An "ls -ln" row ends in "<fd> -> <target>", after a field count that
    # varies by implementation and timestamp format.
    set -- $descriptor
    while [ $# -gt 3 ]; do shift; done
    inherited "$process" "$ppid" "$1" || count=$((count + 1))
  done <<EOF
$descriptors
EOF
  [ "$count" -eq 0 ] || printf 'user\t%s\t%s\n' "$uid" "$count"
done
printf 'end\n'
`;

const buildCommand = (remote: boolean) => {
	const name = `dokploy-inotify-${randomUUID()}`;
	const reader = `busybox@sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0 timeout -s KILL 20 sh -c '${inotifyScanScript.replaceAll("'", "'\\''")}'`;
	return `set -eu
name=${name}
trap 'timeout -k 2 5 docker rm -f "$name" >/dev/null 2>&1 || true' EXIT HUP INT TERM
security=$(timeout -k 2 10 docker info --format '{{json .SecurityOptions}}')
case "$security" in *name=rootless*|*name=userns*) exit 2 ;; esac
set -- --security-opt no-new-privileges
case "$security" in *name=apparmor*) set -- "$@" --security-opt apparmor=unconfined ;; esac
${remote ? "printf 'execution\\t%s\\n' \"$(id -ru)\"" : ""}
timeout -k 3 35 docker run --rm --name "$name" --network none --read-only --cap-drop ALL --cap-add SYS_PTRACE --cap-add DAC_READ_SEARCH --pids-limit 64 --memory 64m --cpus 0.5 --log-driver none --mount type=bind,src=/proc,dst=/host/proc,readonly "$@" ${reader} 2>/dev/null | head -c 65537
`;
};

const running = new Map<string, Promise<InotifyUsage>>();

export const getInotifyUsage = (serverId?: string): Promise<InotifyUsage> => {
	const key = serverId ?? "local";
	const existing = running.get(key);
	if (existing) return existing;
	const pending = (async (): Promise<InotifyUsage> => {
		const result: InotifyUsage = {
			maxWatches: 0,
			maxInstances: 0,
			maxQueuedEvents: 0,
			persisted: null,
			users: [],
			defaultUid: 0,
		};
		try {
			const command = buildCommand(Boolean(serverId));
			const { stdout } = serverId
				? await execAsyncRemote(serverId, command)
				: await execAsync(command);
			if (stdout.length > 65536 || !stdout.endsWith("end\n"))
				throw new Error("Incomplete scan");
			const counts = new Map<number, number>();
			const daemons = new Set<number>();
			let limits = false;
			for (const row of stdout.trimEnd().split("\n").slice(0, -1)) {
				const [kind, ...raw] = row.split("\t");
				if (
					raw.some(
						(value) =>
							!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)),
					)
				)
					throw new Error("Invalid scan");
				const values = raw.map(Number);
				const uid = values[0]!;
				switch (kind) {
					case "limits":
						if (
							limits ||
							values.length !== 3 ||
							values.some((value) => value <= 0)
						)
							throw new Error("Invalid limits");
						[result.maxWatches, result.maxInstances, result.maxQueuedEvents] =
							values as [number, number, number];
						limits = true;
						break;
					case "daemon":
					case "execution":
						if (values.length !== 1) throw new Error("Invalid UID");
						counts.set(uid, counts.get(uid) ?? 0);
						if (kind === "daemon") daemons.add(uid);
						break;
					case "user":
						if (values.length !== 2) throw new Error("Invalid count");
						counts.set(uid, (counts.get(uid) ?? 0) + values[1]!);
						if (!Number.isSafeInteger(counts.get(uid)))
							throw new Error("Invalid count");
						break;
					default:
						throw new Error("Invalid scan");
				}
			}
			if (!limits || daemons.size !== 1)
				throw new Error("Docker daemon UID unavailable or ambiguous");
			result.defaultUid = [...daemons][0]!;
			result.users = [...counts]
				.sort(([a], [b]) => a - b)
				.map(([uid, currentInstances]) => ({
					uid,
					username: null,
					currentInstances,
				}));
			return result;
		} catch {
			return {
				...result,
				users: [],
				error: "The host inotify scan failed or was incomplete.",
			};
		}
	})();
	running.set(key, pending);
	void pending.finally(() => running.delete(key));
	return pending;
};
