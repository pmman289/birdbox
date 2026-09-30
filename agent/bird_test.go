package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
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

func TestReplaceActiveBirdIncludeIgnoresComments(t *testing.T) {
	target := "/var/lib/birdbox/generated.conf"
	source := []byte("# include \"/var/lib/birdbox/generated.conf\";\n/* include \"/var/lib/birdbox/generated.conf\"; */\ninclude \"/var/lib/birdbox/generated.conf\";\n")
	replaced, ok := replaceActiveBirdInclude(source, target, "/tmp/isolated/generated.conf")
	if !ok {
		t.Fatal("expected an active include")
	}
	result := string(replaced)
	if !strings.Contains(result, "# include \"/var/lib/birdbox/generated.conf\";") || !strings.Contains(result, "/* include \"/var/lib/birdbox/generated.conf\"; */") {
		t.Fatalf("commented examples were unexpectedly changed: %s", result)
	}
	if strings.Count(result, "/tmp/isolated/generated.conf") != 1 {
		t.Fatalf("expected one active include replacement: %s", result)
	}
	if _, ok := replaceActiveBirdInclude([]byte("# include \"/var/lib/birdbox/generated.conf\";\n"), target, "/tmp/isolated/generated.conf"); ok {
		t.Fatal("comment-only include must not be accepted")
	}
}

func TestGcBirdVersionsKeepsOnlyReferencedTargets(t *testing.T) {
	directory := t.TempDir()
	generated := filepath.Join(directory, "generated.conf")
	mainVersions := filepath.Join(directory, "versions")
	resourceDir := filepath.Join(directory, "resources")
	resourceVersions := filepath.Join(resourceDir, "versions")
	if err := os.MkdirAll(resourceVersions, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(mainVersions, 0o750); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"generated.conf.active.conf", "generated.conf.candidate.conf", "generated.conf.rollback.conf", "generated.conf.stale.conf",
	} {
		if err := os.WriteFile(filepath.Join(mainVersions, name), []byte(name), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("versions/generated.conf.active.conf", generated); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/generated.conf.candidate.conf", generated+".candidate"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/generated.conf.rollback.conf", generated+".rollback"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"define_demo.active.conf", "define_demo.candidate.conf", "define_demo.stale.conf"} {
		if err := os.WriteFile(filepath.Join(resourceVersions, name), []byte(name), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	activeResource := filepath.Join(resourceDir, "define_demo.conf")
	if err := os.Symlink("versions/define_demo.active.conf", activeResource); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/define_demo.candidate.conf", activeResource+".candidate"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/define_demo.active.conf", activeResource+".rollback"); err != nil {
		t.Fatal(err)
	}

	gcBirdVersions(generated, directory)
	for _, name := range []string{"generated.conf.active.conf", "generated.conf.candidate.conf", "generated.conf.rollback.conf"} {
		if _, err := os.Stat(filepath.Join(mainVersions, name)); err != nil {
			t.Fatalf("referenced main version removed: %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(mainVersions, "generated.conf.stale.conf")); !os.IsNotExist(err) {
		t.Fatalf("stale main version remains: %v", err)
	}
	for _, name := range []string{"define_demo.active.conf", "define_demo.candidate.conf"} {
		if _, err := os.Stat(filepath.Join(resourceVersions, name)); err != nil {
			t.Fatalf("referenced resource version removed: %s: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(resourceVersions, "define_demo.stale.conf")); !os.IsNotExist(err) {
		t.Fatalf("stale resource version remains: %v", err)
	}
}

func TestRepeatedStageKeepsVersionDirectoriesBounded(t *testing.T) {
	directory := t.TempDir()
	generated := filepath.Join(directory, "generated.conf")
	resource := birdResource{RelativePath: "define_demo.conf", Content: "define DEMO = [ 192.0.2.0/24 ];\n"}
	if err := os.MkdirAll(filepath.Join(directory, "resources", "versions"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(directory, "versions"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "versions", "generated.initial.conf"), []byte("protocol device { }\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/generated.initial.conf", generated); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 50; index++ {
		bundle := birdBundle{Main: "protocol device { }\n# stage " + strconv.Itoa(index) + "\n", Resources: []birdResource{{RelativePath: resource.RelativePath, Content: resource.Content + strconv.Itoa(index)}}}
		if err := stageResources(bundle, directory, -1); err != nil {
			t.Fatal(err)
		}
		if _, err := stageMain(bundle, generated, "include", -1); err != nil {
			t.Fatal(err)
		}
		gcBirdVersions(generated, directory)
	}
	countRegular := func(dir, prefix string) int {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasPrefix(entry.Name(), prefix) {
				count++
			}
		}
		return count
	}
	if countRegular(filepath.Join(directory, "versions"), "generated.") > 3 {
		t.Fatalf("main version GC left too many files")
	}
	if countRegular(filepath.Join(directory, "resources", "versions"), "define_") > 3 {
		t.Fatalf("resource version GC left too many files")
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

func TestPrepareIncludeValidationConfigKeepsActiveLinksUntouched(t *testing.T) {
	directory := t.TempDir()
	configDir := filepath.Join(directory, "birdbox")
	versionsDir := filepath.Join(configDir, "versions")
	resourceDir := filepath.Join(configDir, "resources")
	resourceVersions := filepath.Join(resourceDir, "versions")
	if err := os.MkdirAll(resourceVersions, 0o750); err != nil {
		t.Fatal(err)
	}
	generated := filepath.Join(configDir, "generated.conf")
	currentMain := filepath.Join(versionsDir, "generated.current.conf")
	candidateMain := filepath.Join(versionsDir, "generated.candidate.conf")
	if err := os.MkdirAll(versionsDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentMain, []byte("protocol device { }\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	resourceCurrent := filepath.Join(resourceVersions, "define.current.conf")
	resourceCandidate := filepath.Join(resourceVersions, "define.candidate.conf")
	if err := os.WriteFile(resourceCurrent, []byte("define TEST = [ 192.0.2.0/24 ];\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourceCandidate, []byte("define TEST = [ 198.51.100.0/24 ];\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(candidateMain, []byte("include \""+filepath.Join(resourceDir, "define_test.conf")+"\";\nprotocol device { }\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/generated.current.conf", generated); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/generated.candidate.conf", generated+".candidate"); err != nil {
		t.Fatal(err)
	}
	activeResource := filepath.Join(resourceDir, "define_test.conf")
	if err := os.Symlink("versions/define.current.conf", activeResource); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("versions/define.candidate.conf", activeResource+".candidate"); err != nil {
		t.Fatal(err)
	}
	mainPath := filepath.Join(directory, "bird.conf")
	if err := os.WriteFile(mainPath, []byte("include \""+generated+"\";\nprotocol device { }\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	bundle := birdBundle{Main: "ignored", Resources: []birdResource{{RelativePath: "define_test.conf", Content: "define TEST = [ 198.51.100.0/24 ];\n"}}}
	tempMain, tempGenerated, tempDir, err := prepareIncludeValidationConfig(mainPath, generated, bundle, configDir, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)
	activeTarget, err := os.Readlink(generated)
	if err != nil {
		t.Fatal(err)
	}
	if activeTarget != "versions/generated.current.conf" {
		t.Fatalf("active generated target changed during preflight: %q", activeTarget)
	}
	activeTarget, err = os.Readlink(activeResource)
	if err != nil {
		t.Fatal(err)
	}
	if activeTarget != "versions/define.current.conf" {
		t.Fatalf("active resource target changed during preflight: %q", activeTarget)
	}
	mainData, err := os.ReadFile(tempMain)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mainData), tempGenerated) {
		t.Fatalf("temporary main config did not point to temporary generated config: %s", mainData)
	}
	generatedData, err := os.ReadFile(tempGenerated)
	if err != nil {
		t.Fatal(err)
	}
	resolvedCandidate, err := filepath.EvalSymlinks(activeResource + ".candidate")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(generatedData), resolvedCandidate) {
		t.Fatalf("temporary generated config did not point to candidate resource: %s", generatedData)
	}

	// Execute the same isolated parser command through a fake BIRD binary. The
	// production path invokes the real `bird -p`; this verifies the command
	// receives the temporary main config and never needs to switch active links.
	fakeBird := filepath.Join(directory, "bird-check")
	marker := filepath.Join(directory, "parser-input.conf")
	if err := os.WriteFile(fakeBird, []byte("#!/bin/sh\n[ \"$1\" = \"-p\" ] && [ \"$2\" = \"-c\" ] || exit 2\ncat \"$3\" > \""+marker+"\"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	check := runIncludeBirdCheckWith(context.Background(), fakeBird, mainPath, generated, bundle, configDir, -1)
	if !check.ok {
		t.Fatalf("isolated BIRD preflight failed: %#v", check)
	}
	parserInput, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(parserInput), "/birdbox-check-") || strings.Contains(string(parserInput), generated) {
		t.Fatalf("parser did not receive the isolated main config: %s", parserInput)
	}
	activeTarget, err = os.Readlink(generated)
	if err != nil {
		t.Fatal(err)
	}
	if activeTarget != "versions/generated.current.conf" {
		t.Fatalf("active generated target changed while executing preflight: %q", activeTarget)
	}
	activeTarget, err = os.Readlink(activeResource)
	if err != nil {
		t.Fatal(err)
	}
	if activeTarget != "versions/define.current.conf" {
		t.Fatalf("active resource target changed while executing preflight: %q", activeTarget)
	}
}
