package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRequireActiveDeviceProtocolIgnoresComments(t *testing.T) {
	directory := t.TempDir()
	config := filepath.Join(directory, "bird.conf")
	cases := []struct {
		name  string
		input string
		valid bool
	}{
		{name: "named device", input: "protocol device birdbox_device { }\n", valid: true},
		{name: "unnamed device", input: "protocol device { }\n", valid: true},
		{name: "line comment", input: "# protocol device fake { }\n", valid: false},
		{name: "block comment", input: "/* protocol device fake { } */\n", valid: false},
		{name: "quoted text", input: `define example = "protocol device fake { }";`, valid: false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if err := os.WriteFile(config, []byte(item.input), 0o600); err != nil {
				t.Fatal(err)
			}
			err := requireActiveDeviceProtocol(config)
			if item.valid && err != nil {
				t.Fatalf("expected active protocol device, got %v", err)
			}
			if !item.valid && (err == nil || !strings.Contains(err.Error(), "缺少活动 protocol device")) {
				t.Fatalf("expected actionable missing-device error, got %v", err)
			}
		})
	}
}

func TestCapturePathAcceptsRegularFileAndSymlink(t *testing.T) {
	directory := t.TempDir()
	generated := filepath.Join(directory, "generated.conf")
	data := []byte("external change\n")
	if err := os.WriteFile(generated, data, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := capturePath(generated)
	if err != nil || state.kind != "file" || string(state.data) != string(data) {
		t.Fatalf("expected regular file snapshot, got %#v, %v", state, err)
	}
	if err := os.Symlink("versions/current.conf", generated+".link"); err != nil {
		t.Fatal(err)
	}
	state, err = capturePath(generated + ".link")
	if err != nil || state.kind != "symlink" || state.target != "versions/current.conf" {
		t.Fatalf("expected symlink snapshot, got %#v, %v", state, err)
	}
}

func TestRestorePathRestoresExternalRegularFile(t *testing.T) {
	directory := t.TempDir()
	generated := filepath.Join(directory, "generated.conf")
	if err := os.WriteFile(generated, []byte("controller version\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	state, err := capturePath(generated)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(generated, []byte("external edit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := restorePath(generated, state, -1); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(generated)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "controller version\n" {
		t.Fatalf("restored content = %q", content)
	}
	info, err := os.Stat(generated)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("restored mode = %o, want 640", info.Mode().Perm())
	}
}

func TestRestorePathReplacesExternalFileWithControllerSymlink(t *testing.T) {
	directory := t.TempDir()
	generated := filepath.Join(directory, "generated.conf")
	if err := os.WriteFile(generated, []byte("external edit\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	state := pathState{kind: "symlink", target: "versions/controller.conf"}
	if err := restorePath(generated, state, -1); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(generated)
	if err != nil {
		t.Fatal(err)
	}
	if target != state.target {
		t.Fatalf("restored target = %q, want %q", target, state.target)
	}
}

func TestCapturePathRejectsNonRegularFiles(t *testing.T) {
	directory := t.TempDir()
	pipe := filepath.Join(directory, "generated.conf")
	if err := syscall.Mkfifo(pipe, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := capturePath(pipe); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("expected non-regular file error, got %v", err)
	}
}
