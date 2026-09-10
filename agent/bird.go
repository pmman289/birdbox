package main

// Structured BIRD operations for the outbound agent.  This file intentionally
// uses exec.Command with fixed argument positions; only legacy.exec is allowed
// to execute shell source.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const maxBirdConfig = 16 * 1024 * 1024

var safeResourceName = regexp.MustCompile(`^define_[A-Za-z_][A-Za-z0-9_]*\.conf$`)
var safeBirdName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var activeDeviceProtocol = regexp.MustCompile(`(?m)^\s*protocol\s+device(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*\{`)

func interfaceNames(raw string) string {
	var names []string
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		firstColon := strings.IndexByte(line, ':')
		if firstColon < 1 {
			continue
		}
		rest := strings.TrimSpace(line[firstColon+1:])
		secondColon := strings.IndexByte(rest, ':')
		if secondColon < 1 {
			continue
		}
		name := strings.TrimSpace(rest[:secondColon])
		if dot := strings.IndexByte(name, '.'); dot >= 0 {
			name = name[dot+1:]
		}
		if at := strings.IndexByte(name, '@'); at >= 0 {
			name = name[:at]
		}
		if regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`).MatchString(name) {
			names = append(names, name)
		}
	}
	return strings.Join(names, "\n")
}

type birdResource struct {
	RelativePath string
	Content      string
}

type birdBundle struct {
	Main             string
	Resources        []birdResource
	RemovedResources []string
}

type pathState struct {
	kind   string // missing, symlink, file
	target string
	data   []byte
	mode   os.FileMode
}

type commandResult struct {
	stdout string
	stderr string
	code   any
	ok     bool
}

func paramString(params map[string]any, key string) (string, error) {
	value, ok := params[key].(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}

func absoluteSafePath(value string) bool {
	if value == "" || strings.IndexByte(value, 0) >= 0 || !filepath.IsAbs(value) {
		return false
	}
	clean := filepath.Clean(value)
	if clean != value {
		return false
	}
	for _, part := range strings.Split(value, string(filepath.Separator)) {
		if part == ".." {
			return false
		}
	}
	return len(value) <= 4096
}

// BIRD comments are removed before checking declarations so commented
// examples cannot make an Include node appear ready. Strings are preserved
// because a quoted value may contain comment-like characters.
func stripBirdComments(source string) string {
	var out strings.Builder
	inBlock, quoted, escaped := false, false, false
	for i := 0; i < len(source); i++ {
		ch := source[i]
		if inBlock {
			if ch == '*' && i+1 < len(source) && source[i+1] == '/' {
				inBlock = false
				i++
				out.WriteString("  ")
			} else if ch == '\n' {
				out.WriteByte('\n')
			} else {
				out.WriteByte(' ')
			}
			continue
		}
		if quoted {
			out.WriteByte(ch)
			if escaped {
				escaped = false
			} else if ch == '\\' {
				escaped = true
			} else if ch == '"' {
				quoted = false
			}
			continue
		}
		if ch == '"' {
			quoted = true
			out.WriteByte(ch)
			continue
		}
		if ch == '/' && i+1 < len(source) && source[i+1] == '*' {
			inBlock = true
			i++
			out.WriteString("  ")
			continue
		}
		if ch == '/' && i+1 < len(source) && source[i+1] == '/' || ch == '#' {
			for i < len(source) && source[i] != '\n' {
				i++
			}
			if i < len(source) {
				out.WriteByte('\n')
			}
			continue
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func requireActiveDeviceProtocol(mainConfig string) error {
	data, err := os.ReadFile(mainConfig)
	if err != nil {
		return err
	}
	if !activeDeviceProtocol.MatchString(stripBirdComments(string(data))) {
		return fmt.Errorf("BIRD 主配置缺少活动 protocol device 协议。OSPF/接口发现需要 protocol device，请在主配置中添加 protocol device { }; 后重新预检")
	}
	return nil
}

func parseBirdBundle(params map[string]any) (birdBundle, error) {
	main, err := paramString(params, "config")
	if err != nil || len(main) > maxBirdConfig || strings.IndexByte(main, 0) >= 0 {
		return birdBundle{}, fmt.Errorf("invalid config")
	}
	bundle := birdBundle{Main: main}
	if values, ok := params["resources"].([]any); ok {
		for _, raw := range values {
			item, ok := raw.(map[string]any)
			if !ok {
				return birdBundle{}, fmt.Errorf("invalid resource")
			}
			name, ok := item["relativePath"].(string)
			content, contentOK := item["content"].(string)
			if !ok || !contentOK || !safeResourceName.MatchString(name) || len(content) > maxBirdConfig || strings.IndexByte(content, 0) >= 0 {
				return birdBundle{}, fmt.Errorf("invalid resource")
			}
			bundle.Resources = append(bundle.Resources, birdResource{RelativePath: name, Content: content})
		}
	} else if params["resources"] != nil {
		return birdBundle{}, fmt.Errorf("resources must be an array")
	}
	if values, ok := params["removedResources"].([]any); ok {
		for _, raw := range values {
			name, ok := raw.(string)
			if !ok || !safeResourceName.MatchString(name) {
				return birdBundle{}, fmt.Errorf("invalid removed resource")
			}
			bundle.RemovedResources = append(bundle.RemovedResources, name)
		}
	} else if params["removedResources"] != nil {
		return birdBundle{}, fmt.Errorf("removedResources must be an array")
	}
	return bundle, nil
}

func birdPaths(params map[string]any) (mode, mainPath, generatedPath, socketPath, baseDirectory string, err error) {
	mode, err = paramString(params, "deploymentMode")
	if err != nil || (mode != "include" && mode != "legacy") {
		return "", "", "", "", "", fmt.Errorf("invalid deploymentMode")
	}
	mainPath, err = paramString(params, "mainConfigPath")
	if err != nil || !absoluteSafePath(mainPath) {
		return "", "", "", "", "", fmt.Errorf("invalid mainConfigPath")
	}
	generatedPath, err = paramString(params, "generatedConfigPath")
	if err != nil || !absoluteSafePath(generatedPath) {
		return "", "", "", "", "", fmt.Errorf("invalid generatedConfigPath")
	}
	socketPath, err = paramString(params, "socketPath")
	if err != nil || !absoluteSafePath(socketPath) {
		return "", "", "", "", "", fmt.Errorf("invalid socketPath")
	}
	baseDirectory, err = paramString(params, "baseDirectory")
	if err != nil || !absoluteSafePath(baseDirectory) {
		return "", "", "", "", "", fmt.Errorf("invalid baseDirectory")
	}
	return
}

func commandBinary(name string) string {
	for _, candidate := range []string{"/usr/sbin/" + name, "/usr/bin/" + name, name} {
		if candidate == name {
			return candidate
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return name
}

func runCommand(parent context.Context, executable string, args []string, timeout time.Duration, max int64) commandResult {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, commandBinary(executable), args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{target: &stdout, remaining: max}
	cmd.Stderr = &limitedWriter{target: &stderr, remaining: max}
	err := cmd.Run()
	result := commandResult{stdout: stdout.String(), stderr: stderr.String(), ok: err == nil}
	if ctx.Err() != nil {
		result.code = "TIMEOUT"
		result.ok = false
	} else if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			result.code = exit.ExitCode()
		} else {
			result.code = "EXEC_FAILED"
		}
	}
	return result
}

func runBirdc(parent context.Context, socket, command string) commandResult {
	return runCommand(parent, "birdc", []string{"-s", socket, command}, 120*time.Second, 8*1024*1024)
}

func runBirdcVerbose(parent context.Context, socket, command string) commandResult {
	return runCommand(parent, "birdc", []string{"-s", socket, "-v", command}, 120*time.Second, 8*1024*1024)
}

func capturePath(path string) (pathState, error) {
	target, err := os.Readlink(path)
	if err == nil {
		return pathState{kind: "symlink", target: target}, nil
	}
	if !os.IsNotExist(err) {
		return pathState{}, err
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		if os.IsNotExist(readErr) {
			return pathState{kind: "missing"}, nil
		}
		return pathState{}, readErr
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		return pathState{}, statErr
	}
	return pathState{kind: "file", data: data, mode: info.Mode().Perm()}, nil
}

func removePath(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func restorePath(path string, state pathState, gid int) error {
	if err := removePath(path); err != nil {
		return err
	}
	switch state.kind {
	case "missing":
		return nil
	case "symlink":
		return replaceSymlink(path, state.target)
	case "file":
		if err := atomicWrite(path, state.data, state.mode, gid); err != nil {
			return err
		}
		return nil
	default:
		return fmt.Errorf("unknown path state")
	}
}

func replaceSymlink(path, target string) error {
	if !absoluteSafePath(path) || strings.IndexByte(target, 0) >= 0 || target == "" {
		return fmt.Errorf("invalid symlink")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".birdbox-link-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(tmpPath)
	if err := os.Symlink(target, tmpPath); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func atomicWrite(path string, data []byte, mode os.FileMode, gid int) error {
	if !absoluteSafePath(path) {
		return fmt.Errorf("invalid file path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".birdbox-file-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.Write(data)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if gid >= 0 {
		_ = os.Chown(tmpPath, 0, gid)
	}
	return os.Rename(tmpPath, path)
}

func socketGID(socket string) int {
	var stat syscall.Stat_t
	if err := syscall.Stat(socket, &stat); err == nil {
		return int(stat.Gid)
	}
	// OpenWrt and minimal images may have no getent.  The numeric fallback is
	// only used when the socket is not available yet.
	for _, line := range []string{"bird:x:999:", "bird:x:100:"} {
		parts := strings.Split(line, ":")
		if len(parts) > 2 {
			if gid, err := strconv.Atoi(parts[2]); err == nil {
				return gid
			}
		}
	}
	return -1
}

func resourceVersion(content string, relative string) (string, error) {
	if !safeResourceName.MatchString(relative) {
		return "", fmt.Errorf("invalid resource name")
	}
	hash := sha256.Sum256([]byte(content))
	return strings.TrimSuffix(relative, ".conf") + "." + hex.EncodeToString(hash[:])[:16] + ".conf", nil
}

func stageResources(bundle birdBundle, base string, gid int) error {
	resourceDir := filepath.Join(base, "resources")
	versionDir := filepath.Join(resourceDir, "versions")
	if err := os.MkdirAll(versionDir, 0750); err != nil {
		return err
	}
	if gid >= 0 {
		_ = os.Chown(resourceDir, 0, gid)
		_ = os.Chown(versionDir, 0, gid)
		_ = os.Chmod(resourceDir, 0750)
		_ = os.Chmod(versionDir, 0750)
	}
	for _, resource := range bundle.Resources {
		versionName, err := resourceVersion(resource.Content, resource.RelativePath)
		if err != nil {
			return err
		}
		versionPath := filepath.Join(versionDir, versionName)
		if err := atomicWrite(versionPath, []byte(resource.Content), 0640, gid); err != nil {
			return err
		}
		active := filepath.Join(resourceDir, resource.RelativePath)
		if err := replaceSymlink(active+".candidate", filepath.Join("versions", versionName)); err != nil {
			return err
		}
	}
	return nil
}

func stageMain(bundle birdBundle, generated, mode string, gid int) (string, error) {
	if mode == "include" {
		base := filepath.Dir(generated)
		versionName := filepath.Base(generated) + "." + hashPrefix(bundle.Main) + ".conf"
		versionPath := filepath.Join(base, "versions", versionName)
		if err := os.MkdirAll(filepath.Dir(versionPath), 0750); err != nil {
			return "", err
		}
		if gid >= 0 {
			_ = os.Chown(filepath.Dir(versionPath), 0, gid)
			_ = os.Chmod(filepath.Dir(versionPath), 0750)
		}
		if err := atomicWrite(versionPath, []byte(bundle.Main), 0640, gid); err != nil {
			return "", err
		}
		candidate := filepath.Join("versions", versionName)
		if err := replaceSymlink(generated+".candidate", candidate); err != nil {
			return "", err
		}
		return candidate, nil
	}
	candidate := generated + ".candidate"
	if err := atomicWrite(candidate, []byte(bundle.Main), 0640, gid); err != nil {
		return "", err
	}
	return candidate, nil
}

func hashPrefix(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])[:16]
}

func resourceActivePaths(bundle birdBundle, base string) []string {
	paths := make([]string, 0, len(bundle.Resources)+len(bundle.RemovedResources))
	for _, item := range bundle.Resources {
		paths = append(paths, filepath.Join(base, "resources", item.RelativePath))
	}
	for _, item := range bundle.RemovedResources {
		paths = append(paths, filepath.Join(base, "resources", item))
	}
	return paths
}

func discoverResourceCandidates(base string) []string {
	root := filepath.Join(base, "resources")
	var paths []string
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".candidate") {
			return nil
		}
		name := filepath.Base(strings.TrimSuffix(path, ".candidate"))
		if safeResourceName.MatchString(name) {
			paths = append(paths, strings.TrimSuffix(path, ".candidate"))
		}
		return nil
	})
	return paths
}

func switchResourceCandidates(bundle birdBundle, base string) (map[string]pathState, error) {
	paths := resourceActivePaths(bundle, base)
	if len(bundle.Resources) == 0 && len(bundle.RemovedResources) == 0 {
		paths = discoverResourceCandidates(base)
	}
	snapshot := make(map[string]pathState, len(paths))
	for _, active := range paths {
		state, err := capturePath(active)
		if err != nil {
			return snapshot, err
		}
		snapshot[active] = state
		candidate := active + ".candidate"
		target, err := os.Readlink(candidate)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return snapshot, err
		}
		if err := replaceSymlink(active, target); err != nil {
			return snapshot, err
		}
	}
	return snapshot, nil
}

func restoreSnapshot(snapshot map[string]pathState, gid int) error {
	var first error
	for path, state := range snapshot {
		if err := restorePath(path, state, gid); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func runBirdCheck(parent context.Context, mode, generated, socket string) commandResult {
	if mode == "include" {
		return runBirdc(parent, socket, "configure check")
	}
	return runCommand(parent, "bird", []string{"-p", "-c", generated}, 120*time.Second, 8*1024*1024)
}

func stageBirdTask(parent context.Context, params map[string]any, r result) result {
	mode, main, generated, socket, base, err := birdPaths(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_STAGE"
		return r
	}
	if mode == "include" {
		if err = requireActiveDeviceProtocol(main); err != nil {
			r.Stderr, r.Code = err.Error(), "STAGE_FAILED"
			return r
		}
	}
	bundle, err := parseBirdBundle(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_STAGE"
		return r
	}
	gid := socketGID(socket)
	if err = stageResources(bundle, base, gid); err == nil {
		_, err = stageMain(bundle, generated, mode, gid)
	}
	if err != nil {
		r.Stderr, r.Code = err.Error(), "STAGE_FAILED"
		return r
	}
	resourceSnapshot, err := switchResourceCandidates(bundle, base)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "STAGE_FAILED"
		return r
	}
	defer restoreSnapshot(resourceSnapshot, gid)
	state, err := capturePath(generated)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "STAGE_FAILED"
		return r
	}
	if mode == "include" {
		candidate, readErr := os.Readlink(generated + ".candidate")
		if readErr != nil {
			r.Stderr, r.Code = readErr.Error(), "STAGE_FAILED"
			return r
		}
		if err = replaceSymlink(generated, candidate); err != nil {
			r.Stderr, r.Code = err.Error(), "STAGE_FAILED"
			return r
		}
		check := runBirdCheck(parent, mode, generated, socket)
		_ = restorePath(generated, state, gid)
		r.Stdout, r.Stderr, r.OK, r.Code = check.stdout, check.stderr, check.ok, check.code
		return r
	} else {
		check := runBirdCheck(parent, mode, generated+".candidate", socket)
		r.Stdout, r.Stderr, r.OK, r.Code = check.stdout, check.stderr, check.ok, check.code
		return r
	}
}

func applyBirdTask(parent context.Context, params map[string]any, r result) result {
	mode, main, generated, socket, base, err := birdPaths(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_APPLY"
		return r
	}
	if mode == "include" {
		if err = requireActiveDeviceProtocol(main); err != nil {
			r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
			return r
		}
	}
	bundle, err := parseBirdBundle(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_APPLY"
		return r
	}
	gid := socketGID(socket)
	resourcePaths := resourceActivePaths(bundle, base)
	if len(bundle.Resources) == 0 && len(bundle.RemovedResources) == 0 {
		resourcePaths = discoverResourceCandidates(base)
	}
	snapshot := make(map[string]pathState)
	genState, err := capturePath(generated)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
		return r
	}
	snapshot[generated] = genState
	for _, active := range resourcePaths {
		state, stateErr := capturePath(active)
		if stateErr != nil {
			r.Stderr, r.Code = stateErr.Error(), "APPLY_FAILED"
			return r
		}
		snapshot[active] = state
	}
	defer func() {
		_ = snapshot
	}()
	if mode == "include" {
		candidate, readErr := os.Readlink(generated + ".candidate")
		if readErr != nil {
			r.Stderr, r.Code = "generated config candidate is missing", "APPLY_FAILED"
			return r
		}
		if old, ok := genState.target, genState.kind == "symlink"; ok {
			_ = replaceSymlink(generated+".rollback", old)
		}
		if err = replaceSymlink(generated, candidate); err != nil {
			r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
			return r
		}
	} else {
		candidate := generated + ".candidate"
		if _, err = os.Stat(candidate); err != nil {
			r.Stderr, r.Code = "generated config candidate is missing", "APPLY_FAILED"
			return r
		}
		if genState.kind == "file" {
			_ = atomicWrite(generated+".rollback", genState.data, genState.mode, gid)
		}
		if err = os.Rename(candidate, generated); err != nil {
			r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
			return r
		}
	}
	for _, active := range resourcePaths {
		candidate, readErr := os.Readlink(active + ".candidate")
		if readErr == nil {
			if state := snapshot[active]; state.kind == "symlink" {
				_ = replaceSymlink(active+".rollback", state.target)
			}
			if err = replaceSymlink(active, candidate); err != nil {
				_ = restoreSnapshot(snapshot, gid)
				r.Stderr, r.Code = err.Error(), "APPLY_FAILED"
				return r
			}
		} else if !os.IsNotExist(readErr) {
			_ = restoreSnapshot(snapshot, gid)
			r.Stderr, r.Code = readErr.Error(), "APPLY_FAILED"
			return r
		}
	}
	for _, removed := range bundle.RemovedResources {
		_ = removePath(filepath.Join(base, "resources", removed))
	}
	check := runBirdCheck(parent, mode, generated, socket)
	if check.ok {
		if mode == "include" {
			configured := runBirdc(parent, socket, "configure")
			check.stdout += configured.stdout
			check.stderr += configured.stderr
			check.ok = configured.ok
			check.code = configured.code
		}
	}
	if !check.ok {
		_ = restoreSnapshot(snapshot, gid)
		if mode == "include" {
			_ = runBirdc(parent, socket, "configure")
		}
	}
	r.Stdout, r.Stderr, r.OK, r.Code = check.stdout, check.stderr, check.ok, check.code
	return r
}

func rollbackBirdTask(parent context.Context, params map[string]any, r result) result {
	mode, _, generated, socket, base, err := birdPaths(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_ROLLBACK"
		return r
	}
	bundle, err := parseBirdBundle(params)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_ROLLBACK"
		return r
	}
	gid := socketGID(socket)
	snapshot := map[string]pathState{}
	genState, err := capturePath(generated)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "ROLLBACK_FAILED"
		return r
	}
	snapshot[generated] = genState
	paths := resourceActivePaths(bundle, base)
	if len(paths) == 0 {
		paths = discoverResourceCandidates(base)
	}
	for _, active := range paths {
		state, stateErr := capturePath(active)
		if stateErr != nil {
			r.Stderr, r.Code = stateErr.Error(), "ROLLBACK_FAILED"
			return r
		}
		snapshot[active] = state
	}
	if mode == "include" {
		target, readErr := os.Readlink(generated + ".rollback")
		if readErr != nil {
			r.Stderr, r.Code = "generated config rollback is missing", "ROLLBACK_FAILED"
			return r
		}
		if err = replaceSymlink(generated, target); err != nil {
			r.Stderr, r.Code = err.Error(), "ROLLBACK_FAILED"
			return r
		}
	} else {
		data, readErr := os.ReadFile(generated + ".rollback")
		if readErr != nil {
			r.Stderr, r.Code = "generated config rollback is missing", "ROLLBACK_FAILED"
			return r
		}
		if err = atomicWrite(generated, data, 0640, gid); err != nil {
			r.Stderr, r.Code = err.Error(), "ROLLBACK_FAILED"
			return r
		}
	}
	for _, active := range paths {
		if target, readErr := os.Readlink(active + ".rollback"); readErr == nil {
			if err = replaceSymlink(active, target); err != nil {
				_ = restoreSnapshot(snapshot, gid)
				r.Stderr, r.Code = err.Error(), "ROLLBACK_FAILED"
				return r
			}
		}
	}
	check := runBirdCheck(parent, mode, generated, socket)
	if check.ok && mode == "include" {
		configured := runBirdc(parent, socket, "configure")
		check.stdout += configured.stdout
		check.stderr += configured.stderr
		check.ok, check.code = configured.ok, configured.code
	}
	if !check.ok {
		_ = restoreSnapshot(snapshot, gid)
		if mode == "include" {
			_ = runBirdc(parent, socket, "configure")
		}
	}
	r.Stdout, r.Stderr, r.OK, r.Code = check.stdout, check.stderr, check.ok, check.code
	return r
}

func birdTaskStructured(parent context.Context, method string, params map[string]any, r result) result {
	socket, _ := params["socketPath"].(string)
	if socket == "" || !absoluteSafePath(socket) {
		r.Stderr, r.Code = "socketPath must be a safe absolute path", "INVALID_SOCKET"
		return r
	}
	switch method {
	case "bird.inspect":
		version := runCommand(parent, "bird", []string{"--version"}, 15*time.Second, 64*1024)
		protocols := runBirdcVerbose(parent, socket, "show protocols all")
		r.Stdout = version.stdout + version.stderr + "\n---BIRDBOX---\n" + protocols.stdout
		r.Stderr = strings.TrimSpace(version.stderr + "\n" + protocols.stderr)
		r.OK = version.ok && protocols.ok
		if !version.ok {
			r.Code = version.code
		} else if !protocols.ok {
			r.Code = protocols.code
		}
		return r
	case "bird.protocol":
		protocolName, _ := params["protocolName"].(string)
		if protocolName != "" && !safeBirdName.MatchString(protocolName) {
			r.Stderr, r.Code = "invalid protocol name", "INVALID_PROTOCOL"
			return r
		}
		command := "show protocols all"
		if protocolName != "" {
			command += " " + protocolName
		}
		out := runBirdcVerbose(parent, socket, command)
		r.Stdout, r.Stderr, r.OK, r.Code = out.stdout, out.stderr, out.ok, out.code
		return r
	case "bird.routes":
		return birdRoutesTask(parent, params, r)
	case "bird.protocol_state":
		name, ok := params["protocolName"].(string)
		enabled, enabledOK := params["enabled"].(bool)
		if !ok || !enabledOK || !safeBirdName.MatchString(name) {
			r.Stderr, r.Code = "invalid protocol state parameters", "INVALID_PROTOCOL"
			return r
		}
		out := runBirdc(parent, socket, map[bool]string{true: "enable ", false: "disable "}[enabled]+name)
		r.Stdout, r.Stderr, r.OK, r.Code = out.stdout, out.stderr, out.ok, out.code
		return r
	case "bird.ospf":
		return birdOspfTask(parent, params, r)
	case "bird.access":
		return birdAccessTask(parent, params, r)
	case "bird.stage":
		return stageBirdTask(parent, params, r)
	case "bird.apply":
		return applyBirdTask(parent, params, r)
	case "bird.rollback":
		return rollbackBirdTask(parent, params, r)
	default:
		r.Stderr, r.Code = "unsupported task method: "+method, "METHOD_NOT_ALLOWED"
		return r
	}
}

func birdRoutesTask(parent context.Context, params map[string]any, r result) result {
	table, tableOK := params["table"].(string)
	protocol, _ := params["protocolName"].(string)
	direction, _ := params["direction"].(string)
	target, _ := params["target"].(string)
	if !tableOK || !safeBirdName.MatchString(table) || protocol != "" && !safeBirdName.MatchString(protocol) {
		r.Stderr, r.Code = "invalid route query parameters", "INVALID_ROUTE_QUERY"
		return r
	}
	if target != "" {
		baseTarget := target
		if index := strings.LastIndex(baseTarget, "%"); index >= 0 {
			baseTarget = baseTarget[:index]
		}
		if net.ParseIP(baseTarget) == nil || strings.ContainsAny(target, " \t\r\n'\"") {
			r.Stderr, r.Code = "invalid route target", "INVALID_ROUTE_QUERY"
			return r
		}
	}
	command := "show route table " + table
	if target != "" {
		command += " for " + target + " all"
	} else {
		if direction == "import" {
			if protocol == "" {
				r.Stderr, r.Code = "protocolName is required", "INVALID_ROUTE_QUERY"
				return r
			}
			command += " protocol " + protocol + " all"
		} else if direction == "export" {
			if protocol == "" {
				r.Stderr, r.Code = "protocolName is required", "INVALID_ROUTE_QUERY"
				return r
			}
			command += " export " + protocol + " all"
		} else {
			command += " all"
		}
	}
	out := runBirdc(parent, params["socketPath"].(string), command)
	r.Stdout, r.Stderr, r.OK, r.Code = out.stdout, out.stderr, out.ok, out.code
	return r
}

func birdOspfTask(parent context.Context, params map[string]any, r result) result {
	v2, _ := params["v2"].(string)
	v3, _ := params["v3"].(string)
	if !safeBirdName.MatchString(v2) || !safeBirdName.MatchString(v3) {
		r.Stderr, r.Code = "invalid OSPF protocol names", "INVALID_OSPF"
		return r
	}
	socket := params["socketPath"].(string)
	neighbors := runBirdc(parent, socket, "show ospf neighbors")
	v2count := runBirdc(parent, socket, "show route protocol "+v2+" count")
	v3count := runBirdc(parent, socket, "show route protocol "+v3+" count")
	v2routes := runBirdc(parent, socket, "show route table master4 protocol "+v2+" all")
	v3routes := runBirdc(parent, socket, "show route table master6 protocol "+v3+" all")
	interfaces := runCommand(parent, "ip", []string{"-o", "link", "show"}, 15*time.Second, 512*1024)
	r.Stdout = neighbors.stdout + "\n---BIRDBOX-OSPF-V2-COUNT---\n" + v2count.stdout + "\n---BIRDBOX-OSPF-V2-ROUTES---\n" + v2routes.stdout + "\n---BIRDBOX-OSPF-V3-COUNT---\n" + v3count.stdout + "\n---BIRDBOX-OSPF-V3-ROUTES---\n" + v3routes.stdout + "\n---BIRDBOX-OSPF-INTERFACES---\n" + interfaceNames(interfaces.stdout)
	r.Stderr = strings.TrimSpace(strings.Join([]string{neighbors.stderr, v2count.stderr, v3count.stderr, v2routes.stderr, v3routes.stderr, interfaces.stderr}, "\n"))
	// Missing OSPF protocols are valid on a node.  The operation is healthy if
	// the controller could execute the queries and retrieve interface data.
	r.OK = interfaces.ok
	if !interfaces.ok {
		r.Code = interfaces.code
	}
	return r
}

func birdAccessTask(parent context.Context, params map[string]any, r result) result {
	mainConfig, _ := params["mainConfigPath"].(string)
	generated, _ := params["generatedConfigPath"].(string)
	socket, _ := params["socketPath"].(string)
	for _, item := range []struct{ path, label string }{{mainConfig, "main config"}, {generated, "generated config"}} {
		if !absoluteSafePath(item.path) {
			r.Stderr, r.Code = "invalid "+item.label+" path", "INVALID_ACCESS"
			return r
		}
		if _, err := os.Stat(item.path); err != nil {
			r.Stderr, r.Code = item.label+": "+err.Error(), "ACCESS_FAILED"
			return r
		}
	}
	if err := requireActiveDeviceProtocol(mainConfig); err != nil {
		r.Stderr, r.Code = err.Error(), "ACCESS_FAILED"
		return r
	}
	out := runBirdc(parent, socket, "show status")
	r.Stdout, r.Stderr, r.OK, r.Code = out.stdout+"\n---BIRDBOX-ACCESS---\n"+os.Getenv("USER"), out.stderr, out.ok, out.code
	return r
}
