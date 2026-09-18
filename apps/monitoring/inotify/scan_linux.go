//go:build linux

package inotify

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// kcmpFile is the KCMP_FILE type argument of kcmp(2).
const kcmpFile = 0

type descriptor struct {
	pid int
	fd  int
}

func scan(root string, out io.Writer) error {
	limits := [...]string{
		"max_user_watches",
		"max_user_instances",
		"max_queued_events",
	}
	values := make([]int, len(limits))
	for i, name := range limits {
		value, err := readInt(filepath.Join(root, "sys/fs/inotify", name))
		if err != nil {
			return err
		}
		values[i] = value
	}
	if _, err := fmt.Fprintf(out, "limits\t%d\t%d\t%d\n", values[0], values[1], values[2]); err != nil {
		return err
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	byUID := map[int][]descriptor{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		uid, name, err := readStatus(filepath.Join(root, entry.Name(), "status"))
		if err != nil {
			// The process exited while the directory was being read.
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if name == "dockerd" {
			if _, err := fmt.Fprintf(out, "daemon\t%d\n", uid); err != nil {
				return err
			}
		}
		found, err := inotifyDescriptors(root, pid)
		if err != nil {
			return err
		}
		if len(found) == 0 {
			continue
		}
		byUID[uid] = append(byUID[uid], found...)
	}

	uids := make([]int, 0, len(byUID))
	for uid := range byUID {
		uids = append(uids, uid)
	}
	sort.Ints(uids)
	for _, uid := range uids {
		held := byUID[uid]
		instances, err := countInstances(held)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(out, "user\t%d\t%d\t%d\n", uid, len(held), instances); err != nil {
			return err
		}
	}
	_, err = io.WriteString(out, "end\n")
	return err
}

// countInstances returns how many distinct inotify instances the descriptors
// refer to. kcmp reports ESRCH when either process has exited and EBADF when
// either descriptor has closed, without saying which side, so each descriptor
// is checked against itself first: a descriptor that is gone is no longer
// charged and is skipped, and a representative that is gone is dropped rather
// than allowed to swallow the live descriptors compared against it.
func countInstances(descriptors []descriptor) (int, error) {
	representatives := make([]descriptor, 0, len(descriptors))
	for _, held := range descriptors {
		if _, err := sameFile(held, held); err != nil {
			if gone(err) {
				continue
			}
			return 0, err
		}
		known := false
		live := representatives[:0]
		for _, representative := range representatives {
			same, err := sameFile(representative, held)
			if err != nil {
				if gone(err) {
					continue
				}
				return 0, err
			}
			live = append(live, representative)
			known = known || same
		}
		representatives = live
		if !known {
			representatives = append(representatives, held)
		}
	}
	return len(representatives), nil
}

func gone(err error) bool {
	return err == unix.ESRCH || err == unix.ENOENT || err == unix.EBADF
}

func sameFile(a, b descriptor) (bool, error) {
	result, _, errno := unix.Syscall6(
		unix.SYS_KCMP,
		uintptr(a.pid), uintptr(b.pid),
		kcmpFile,
		uintptr(a.fd), uintptr(b.fd),
		0,
	)
	if errno != 0 {
		return false, errno
	}
	return result == 0, nil
}

func inotifyDescriptors(root string, pid int) ([]descriptor, error) {
	dir := filepath.Join(root, strconv.Itoa(pid), "fd")
	entries, err := os.ReadDir(dir)
	if err != nil {
		// The process exited, or its fd table is not readable by this reader.
		if os.IsNotExist(err) || os.IsPermission(err) {
			return nil, nil
		}
		return nil, err
	}
	var found []descriptor
	for _, entry := range entries {
		fd, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		target, err := os.Readlink(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		if target != "anon_inode:inotify" && target != "anon_inode:[inotify]" {
			continue
		}
		found = append(found, descriptor{pid: pid, fd: fd})
	}
	return found, nil
}

func readStatus(path string) (uid int, name string, err error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	uid = -1
	lines := bufio.NewScanner(file)
	for lines.Scan() {
		field, value, found := strings.Cut(lines.Text(), ":")
		if !found {
			continue
		}
		value = strings.TrimSpace(value)
		switch field {
		case "Name":
			name = value
		case "Uid":
			// "Uid: <real> <effective> <saved> <filesystem>"; the kernel charges
			// the real UID.
			real, _, _ := strings.Cut(value, "\t")
			uid, err = strconv.Atoi(strings.TrimSpace(real))
			if err != nil {
				return 0, "", fmt.Errorf("%s: unreadable Uid: %w", path, err)
			}
			return uid, name, nil
		}
	}
	if err := lines.Err(); err != nil {
		return 0, "", err
	}
	return 0, "", fmt.Errorf("%s: no Uid field", path)
}

func readInt(path string) (int, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0, fmt.Errorf("%s: %w", path, err)
	}
	if value <= 0 {
		return 0, fmt.Errorf("%s: not a positive limit: %d", path, value)
	}
	return value, nil
}
