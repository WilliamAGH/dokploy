//go:build linux

package inotify

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// Two instances watching the same directory report identical fdinfo, and every
// anon_inode descriptor reports the same inode, so only kcmp separates them
// from the two references a dup (or a fork) creates to one instance.
func TestCountInstancesSeparatesSharedReferencesFromDistinctInstances(t *testing.T) {
	watched := t.TempDir()
	pid := os.Getpid()

	instance := func() int {
		fd, err := unix.InotifyInit1(unix.IN_CLOEXEC)
		if err != nil {
			t.Fatalf("inotify_init1: %v", err)
		}
		t.Cleanup(func() { unix.Close(fd) })
		if _, err := unix.InotifyAddWatch(fd, watched, unix.IN_MODIFY); err != nil {
			t.Fatalf("inotify_add_watch: %v", err)
		}
		return fd
	}

	first, second := instance(), instance()
	reference, err := unix.Dup(first)
	if err != nil {
		t.Fatalf("dup: %v", err)
	}
	t.Cleanup(func() { unix.Close(reference) })

	if a, b := fdinfo(t, pid, first), fdinfo(t, pid, second); a != b {
		t.Fatalf("expected identical fdinfo for distinct instances, got\n%s\nand\n%s", a, b)
	}

	got, err := countInstances([]descriptor{
		{pid: pid, fd: first},
		{pid: pid, fd: reference},
		{pid: pid, fd: second},
	})
	if err != nil {
		// Docker's default seccomp profile permits kcmp only with
		// CAP_SYS_PTRACE, which the scan container is given.
		t.Fatalf("countInstances: %v (kcmp needs CAP_SYS_PTRACE under Docker's default seccomp profile)", err)
	}
	if got != 2 {
		t.Fatalf("counted %d instances across 3 descriptors, want 2", got)
	}
}

func TestCountInstancesDropsDescriptorsOfProcessesThatExited(t *testing.T) {
	watched := t.TempDir()
	pid := os.Getpid()
	live, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		t.Fatalf("inotify_init1: %v", err)
	}
	t.Cleanup(func() { unix.Close(live) })
	if _, err := unix.InotifyAddWatch(live, watched, unix.IN_MODIFY); err != nil {
		t.Fatalf("inotify_add_watch: %v", err)
	}

	// PID 0 never names a process, so kcmp reports ESRCH for it. A stale
	// descriptor enumerated first must not swallow the live ones after it.
	got, err := countInstances([]descriptor{
		{pid: 0, fd: 0},
		{pid: pid, fd: live},
		{pid: 0, fd: 1},
	})
	if err != nil {
		t.Fatalf("countInstances: %v", err)
	}
	if got != 1 {
		t.Fatalf("counted %d instances, want only the live one", got)
	}
}

func TestReadStatusReportsTheRealUID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "status")
	write(t, path, "Name:\tsystemd-udevd\nState:\tS (sleeping)\nPPid:\t1\nUid:\t1000\t0\t0\t0\n")
	uid, name, err := readStatus(path)
	if err != nil {
		t.Fatalf("readStatus: %v", err)
	}
	if uid != 1000 || name != "systemd-udevd" {
		t.Fatalf("got uid %d name %q, want 1000 and systemd-udevd", uid, name)
	}
}

func TestReadIntRejectsANonPositiveLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "max_user_instances")
	write(t, path, "0\n")
	if _, err := readInt(path); err == nil {
		t.Fatal("expected a zero limit to be rejected")
	}
}

func TestInotifyDescriptorsFindsOnlyInotifyDescriptors(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "42", "fd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, target := range map[string]string{
		"3": "anon_inode:inotify",
		"4": "anon_inode:[inotify]",
		"5": "socket:[12345]",
		"6": "/etc/hosts",
	} {
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	found, err := inotifyDescriptors(root, 42)
	if err != nil {
		t.Fatalf("inotifyDescriptors: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("found %d descriptors, want 3 and 4", len(found))
	}
}

func fdinfo(t *testing.T, pid, fd int) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "fdinfo", strconv.Itoa(fd)))
	if err != nil {
		t.Fatalf("read fdinfo: %v", err)
	}
	// mnt_id and ino are per-anon-inode constants; the watch list follows.
	_, list, _ := strings.Cut(string(raw), "inotify")
	return list
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
