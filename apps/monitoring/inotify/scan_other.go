//go:build !linux

package inotify

import (
	"errors"
	"io"
)

func scan(string, io.Writer) error {
	return errors.New("the inotify scan requires Linux")
}
