// Package inotify reports how many inotify instances each host UID holds.
//
// fs.inotify.max_user_instances is charged once per inotify instance, not per
// descriptor referring to one: a descriptor inherited across fork() is another
// reference to the instance its opener was charged for. Nothing in /proc
// distinguishes the two -- descriptors that refer to one instance report
// identical fdinfo, but so do separate instances watching identical paths, and
// every anon_inode file shares one inode number. kcmp(2) with KCMP_FILE
// compares the underlying file objects and is the only sound test, which is
// why this runs as a compiled reader rather than a shell script.
package inotify

import "io"

// Scan writes the report the Dokploy control plane parses, one row per line:
//
//	limits\t<max_user_watches>\t<max_user_instances>\t<max_queued_events>
//	daemon\t<uid>                  once per running dockerd
//	user\t<uid>\t<references>\t<instances>
//	end
//
// root is the mount point of the host's /proc. The caller must share the
// host's PID namespace: kcmp resolves its arguments in the caller's namespace,
// so PIDs read from root are otherwise meaningless.
func Scan(root string, out io.Writer) error {
	return scan(root, out)
}
