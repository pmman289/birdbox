package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrUnauthorized = errors.New("agent credentials rejected")
var upgradeHTTPClient = http.DefaultClient

type Client struct {
	cfg    Config
	http   *http.Client
	upload *http.Client
}
type registration struct {
	NodeID          string   `json:"nodeId"`
	Token           string   `json:"token"`
	AgentVersion    string   `json:"agentVersion"`
	ProtocolVersion int      `json:"protocolVersion"`
	Capabilities    []string `json:"capabilities"`
	Platform        string   `json:"platform"`
	Architecture    string   `json:"architecture"`
	Hostname        string   `json:"hostname"`
}
type task struct {
	TaskID     string         `json:"taskId"`
	NodeID     string         `json:"nodeId"`
	Method     string         `json:"method"`
	Params     map[string]any `json:"params"`
	DeadlineAt string         `json:"deadlineAt"`
}
type pollResponse struct {
	Task *task `json:"task"`
}
type result struct {
	TaskID string `json:"taskId"`
	NodeID string `json:"nodeId"`
	OK     bool   `json:"ok"`
	Stdout string `json:"stdout"`
	Stderr string `json:"stderr"`
	Code   any    `json:"code,omitempty"`
	Result any    `json:"result,omitempty"`
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 45 * time.Second}, upload: &http.Client{Timeout: 5 * time.Minute}}
}

func NewClientWithTransport(cfg Config, transport *http.Transport) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 45 * time.Second, Transport: transport}, upload: &http.Client{Timeout: 5 * time.Minute, Transport: transport}}
}

const (
	maxControllerResponse = 24 * 1024 * 1024
	maxResultStdout       = 6 * 1024 * 1024
	maxResultStderr       = 1 * 1024 * 1024
)

func (c *Client) request(ctx context.Context, method, path string, body any, response any) error {
	return c.doRequest(ctx, c.http, method, path, body, response)
}

func (c *Client) doRequest(ctx context.Context, client *http.Client, method, path string, body any, response any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.ControllerURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxControllerResponse+1))
	if err != nil {
		return err
	}
	if len(data) > maxControllerResponse {
		return fmt.Errorf("controller response exceeds %d bytes", maxControllerResponse)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("controller returned %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	if response != nil && len(data) > 0 {
		if err := json.Unmarshal(data, response); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) Register(ctx context.Context, version string) error {
	var out map[string]any
	capabilities := []string{"system.info", "system.interfaces", "network.ip_rules", "bird.inspect", "bird.validate", "bird.stage", "bird.apply", "bird.rollback", "bird.protocol", "bird.routes", "bird.protocol_state", "bird.ospf", "bird.access", "agent.self_upgrade", "task.large_payload"}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("BIRDBOX_AGENT_LEGACY_EXEC")), "enabled") {
		capabilities = append(capabilities, "legacy.exec")
	}
	return c.request(ctx, http.MethodPost, "/api/agent/register", registration{
		NodeID: c.cfg.NodeID, Token: c.cfg.Token, AgentVersion: version, ProtocolVersion: 1,
		Capabilities: capabilities,
		Platform:     runtime.GOOS, Architecture: reportedArchitecture(), Hostname: hostname(),
	}, &out)
}

func hostname() string { h, _ := os.Hostname(); return h }

func (c *Client) RunPoll(ctx context.Context) error {
	var response pollResponse
	if err := c.request(ctx, http.MethodPost, "/api/agent/tasks/poll", map[string]any{"nodeId": c.cfg.NodeID}, &response); err != nil {
		log.Printf("agent poll failed node_id=%s error=%v", c.cfg.NodeID, err)
		return err
	}
	if response.Task == nil {
		return nil
	}
	log.Printf("agent task started node_id=%s task_id=%s method=%s", c.cfg.NodeID, response.Task.TaskID, response.Task.Method)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, response.Task.DeadlineAt)
	if deadlineErr != nil {
		log.Printf("dropping agent task with invalid deadline node_id=%s task_id=%s method=%s", c.cfg.NodeID, response.Task.TaskID, response.Task.Method)
		return c.deliverResult(ctx, response.Task, result{
			TaskID: response.Task.TaskID, NodeID: c.cfg.NodeID, Stderr: "task deadline is invalid", Code: "TASK_INVALID_DEADLINE",
		})
	}
	if time.Now().After(deadline) {
		log.Printf("dropping expired agent task node_id=%s task_id=%s method=%s", c.cfg.NodeID, response.Task.TaskID, response.Task.Method)
		return c.deliverResult(ctx, response.Task, result{
			TaskID: response.Task.TaskID, NodeID: c.cfg.NodeID, Stderr: "task deadline expired", Code: "TASK_EXPIRED",
		})
	}
	taskContext := ctx
	// The controller removes a task from its pending set at the deadline and
	// may start a rollback. Every operation, including mutating BIRD changes,
	// must stop at that same boundary so a late agent cannot keep changing the
	// node after the controller has moved on.
	var cancel context.CancelFunc
	taskContext, cancel = context.WithDeadline(ctx, deadline)
	defer cancel()
	heartbeatCtx, stopHeartbeat := context.WithCancel(taskContext)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case <-ticker.C:
				if err := c.request(heartbeatCtx, http.MethodPost, "/api/agent/heartbeat", map[string]any{"nodeId": c.cfg.NodeID}, nil); err != nil {
					log.Printf("agent heartbeat failed while running task node_id=%s error=%v", c.cfg.NodeID, err)
				}
			}
		}
	}()
	r := executeTask(taskContext, *response.Task)
	stopHeartbeat()
	<-heartbeatDone
	r.Stdout = truncateUTF8(r.Stdout, maxResultStdout)
	r.Stderr = truncateUTF8(r.Stderr, maxResultStderr)
	log.Printf("agent task finished node_id=%s task_id=%s method=%s ok=%t code=%v", c.cfg.NodeID, response.Task.TaskID, response.Task.Method, r.OK, r.Code)
	if err := c.deliverResult(ctx, response.Task, r); err != nil {
		log.Printf("agent task result delivery failed node_id=%s task_id=%s error=%v", c.cfg.NodeID, response.Task.TaskID, err)
		return err
	}
	return nil
}

func (c *Client) deliverResult(ctx context.Context, t *task, r result) error {
	return c.doRequest(ctx, c.upload, http.MethodPost, "/api/agent/tasks/"+t.TaskID+"/result", r, nil)
}

func readOnlyTask(method string) bool {
	switch method {
	case "system.info", "system.interfaces", "bird.inspect", "bird.protocol", "bird.routes", "bird.ospf", "bird.access":
		return true
	default:
		return false
	}
}

func truncateUTF8(value string, max int) string {
	if len(value) <= max {
		return value
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(value[cut]) {
		cut--
	}
	return value[:cut] + "\n...[birdbox-agent: output truncated]"
}

func executeTask(parent context.Context, t task) result {
	r := result{TaskID: t.TaskID, NodeID: t.NodeID}
	if t.Method == "system.info" {
		r.OK = true
		r.Result = map[string]any{"os": runtime.GOOS, "arch": runtime.GOARCH, "hostname": hostname(), "agentVersion": version}
		return r
	}
	if t.Method == "system.interfaces" {
		out := runCommand(parent, "ip", []string{"-o", "link", "show"}, 15*time.Second, 512*1024)
		r.Stdout, r.Stderr, r.OK, r.Code = interfaceNames(out.stdout), out.stderr, out.ok, out.code
		return r
	}
	if t.Method == "network.ip_rules" {
		return networkIPRulesTask(parent, t.Params, r)
	}
	if t.Method == "agent.self_upgrade" {
		return upgradeTask(parent, t, r)
	}
	if strings.HasPrefix(t.Method, "bird.") {
		return birdTask(parent, t, r)
	}
	if t.Method != "legacy.exec" {
		r.Stderr = "unsupported task method: " + t.Method
		r.Code = "METHOD_NOT_ALLOWED"
		return r
	}
	command, _ := t.Params["command"].(string)
	if command == "" || len(command) > 256*1024 || strings.IndexByte(command, 0) >= 0 {
		r.Stderr = "invalid command"
		r.Code = "INVALID_COMMAND"
		return r
	}
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("BIRDBOX_AGENT_LEGACY_EXEC")), "enabled") {
		r.Stderr = "legacy.exec disabled on this agent; use structured RPC"
		r.Code = "METHOD_NOT_ALLOWED"
		return r
	}
	if input, ok := t.Params["input"].(string); ok && (len(input) > 16*1024*1024 || strings.IndexByte(input, 0) >= 0) {
		r.Stderr = "invalid command input"
		r.Code = "INVALID_INPUT"
		return r
	}
	timeout := 120 * time.Second
	if n, ok := t.Params["timeoutMs"].(float64); ok && n >= 250 && n <= 120000 {
		timeout = time.Duration(n) * time.Millisecond
	}
	maxBuffer := int64(2 * 1024 * 1024)
	if n, ok := t.Params["maxBuffer"].(float64); ok && n >= 1024 && n <= 8*1024*1024 {
		maxBuffer = int64(n)
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	if input, ok := t.Params["input"].(string); ok {
		cmd.Stdin = strings.NewReader(input)
	}
	stdout, stderr, err := runLimited(cmd, maxBuffer)
	r.Stdout, r.Stderr = stdout, stderr
	r.OK = err == nil
	if ctx.Err() != nil {
		r.OK = false
		r.Code = "TIMEOUT"
	} else if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			r.Code = exit.ExitCode()
		} else {
			r.Code = "EXEC_FAILED"
		}
	}
	return r
}

func birdTask(parent context.Context, t task, r result) result {
	if t.Method == "bird.validate" {
		return stageBirdTask(parent, t.Params, r)
	}
	return birdTaskStructured(parent, t.Method, t.Params, r)
}

func runLimited(cmd *exec.Cmd, max int64) (string, string, error) {
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{target: &stdout, remaining: max}
	cmd.Stderr = &limitedWriter{target: &stderr, remaining: max}
	err := cmd.Run()
	return stdout.String(), stderr.String(), err
}

type limitedWriter struct {
	target    *bytes.Buffer
	remaining int64
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.remaining <= 0 {
		return len(p), nil
	}
	n := int64(len(p))
	if n > w.remaining {
		n = w.remaining
	}
	_, _ = w.target.Write(p[:n])
	w.remaining -= n
	return len(p), nil
}

func upgradeTask(parent context.Context, t task, r result) result {
	url, _ := t.Params["url"].(string)
	sha, _ := t.Params["sha256"].(string)
	target, _ := t.Params["targetPath"].(string)
	service, _ := t.Params["service"].(string)
	if url == "" || target == "" || !filepath.IsAbs(target) || strings.IndexByte(target, 0) >= 0 || len(sha) != 64 {
		r.Stderr = "upgrade requires an absolute targetPath, url and sha256"
		r.Code = "INVALID_UPGRADE"
		return r
	}
	if service != "" && !regexp.MustCompile(`^[A-Za-z0-9_.@-]+$`).MatchString(service) {
		r.Stderr = "invalid service name"
		r.Code = "INVALID_UPGRADE"
		return r
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		r.Stderr = err.Error()
		r.Code = "DOWNLOAD_FAILED"
		return r
	}
	resp, err := upgradeHTTPClient.Do(req)
	if err != nil {
		r.Stderr = err.Error()
		r.Code = "DOWNLOAD_FAILED"
		return r
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		r.Stderr = resp.Status
		r.Code = "DOWNLOAD_FAILED"
		return r
	}
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".birdbox-agent-*")
	if err != nil {
		r.Stderr = err.Error()
		r.Code = "INSTALL_FAILED"
		return r
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	h := sha256.New()
	if _, err = io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, 128*1024*1024)); err != nil {
		tmp.Close()
		r.Stderr = err.Error()
		r.Code = "DOWNLOAD_FAILED"
		return r
	}
	if err = tmp.Close(); err != nil {
		r.Stderr = err.Error()
		r.Code = "INSTALL_FAILED"
		return r
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), sha) {
		r.Stderr = "sha256 mismatch"
		r.Code = "CHECKSUM_FAILED"
		return r
	}
	if err = os.Chmod(tmpName, 0755); err != nil {
		r.Stderr = err.Error()
		r.Code = "INSTALL_FAILED"
		return r
	}
	if err = probeBinary(ctx, tmpName); err != nil {
		r.Stderr = "new agent binary cannot run on this host: " + err.Error()
		r.Code = "INSTALL_FAILED"
		return r
	}
	if err := ctx.Err(); err != nil {
		r.Stderr = "upgrade deadline exceeded: " + err.Error()
		r.Code = "TIMEOUT"
		return r
	}
	if _, statErr := os.Stat(target); statErr == nil {
		_ = os.Remove(target + ".prev")
		_ = os.Link(target, target+".prev")
	}
	if err = os.Rename(tmpName, target); err != nil {
		r.Stderr = err.Error()
		r.Code = "INSTALL_FAILED"
		return r
	}
	if service != "" {
		scheduleServiceRestart(service)
	}
	r.OK = true
	r.Result = map[string]any{"version": t.Params["version"]}
	return r
}

func probeBinary(parent context.Context, path string) error {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "-version")
	cmd.Env = []string{}
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(interface {
			Signaled() bool
			Signal() os.Signal
		}); ok && status.Signaled() {
			return fmt.Errorf("killed by signal %s", status.Signal())
		}
		// Older agents may not understand -version; exit status 1 still proves
		// that the host can execute the binary.
		if exitErr.ExitCode() == 1 {
			return nil
		}
	}
	return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
}

func scheduleServiceRestart(service string) {
	// Return the upgrade result first. Restarting the current process inline
	// would terminate it before it can POST the task result to the controller.
	time.AfterFunc(5*time.Second, func() {
		if _, err := exec.LookPath("systemctl"); err == nil {
			if err := exec.Command("systemctl", "restart", service).Run(); err == nil {
				return
			}
		}
		if _, err := exec.LookPath("service"); err == nil {
			_ = exec.Command("service", service, "restart").Run()
		}
	})
}
