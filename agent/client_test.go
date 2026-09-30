package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoadConfigRequiresAllValues(t *testing.T) {
	t.Setenv("BIRDBOX_CONTROLLER_URL", "")
	t.Setenv("BIRDBOX_NODE_ID", "")
	t.Setenv("BIRDBOX_AGENT_TOKEN", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected missing config error")
	}
}

func TestExecuteTaskRejectsUnsupportedMethod(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "unknown", Params: map[string]any{}})
	if result.OK || !strings.Contains(result.Stderr, "unsupported") {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsNulCommand(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "legacy.exec", Params: map[string]any{"command": "echo\x00bad"}})
	if result.OK || result.Code != "INVALID_COMMAND" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestLegacyExecIsDisabledUnlessExplicitlyEnabled(t *testing.T) {
	t.Setenv("BIRDBOX_AGENT_LEGACY_EXEC", "")
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "legacy.exec", Params: map[string]any{"command": "printf unsafe"}})
	if result.OK || result.Code != "METHOD_NOT_ALLOWED" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestReadOnlyTaskDeadlinePolicy(t *testing.T) {
	if !readOnlyTask("bird.inspect") || !readOnlyTask("system.interfaces") || readOnlyTask("bird.apply") || readOnlyTask("bird.protocol_state") {
		t.Fatal("unexpected read-only task classification")
	}
}

func TestRunPollDoesNotExecuteTaskWithInvalidDeadline(t *testing.T) {
	var received result
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/agent/tasks/poll" {
			_ = json.NewEncoder(w).Encode(pollResponse{Task: &task{
				TaskID: "invalid-deadline", NodeID: "node", Method: "legacy.exec",
				Params: map[string]any{"command": "false"}, DeadlineAt: "not-a-timestamp",
			}})
			return
		}
		if request.URL.Path == "/api/agent/tasks/invalid-deadline/result" {
			if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
				t.Errorf("decode result: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
		http.NotFound(w, request)
	}))
	defer server.Close()
	client := NewClient(Config{ControllerURL: server.URL, NodeID: "node", Token: "token"})
	if err := client.RunPoll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if received.OK || received.Code != "TASK_INVALID_DEADLINE" {
		t.Fatalf("unexpected invalid-deadline result: %#v", received)
	}
}

func TestRunPollDoesNotExecuteExpiredTask(t *testing.T) {
	var received result
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/agent/tasks/poll" {
			_ = json.NewEncoder(w).Encode(pollResponse{Task: &task{
				TaskID: "expired", NodeID: "node", Method: "legacy.exec",
				Params: map[string]any{"command": "false"}, DeadlineAt: time.Now().Add(-time.Second).Format(time.RFC3339Nano),
			}})
			return
		}
		if request.URL.Path == "/api/agent/tasks/expired/result" {
			if err := json.NewDecoder(request.Body).Decode(&received); err != nil {
				t.Errorf("decode result: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
			return
		}
		http.NotFound(w, request)
	}))
	defer server.Close()
	client := NewClient(Config{ControllerURL: server.URL, NodeID: "node", Token: "token"})
	if err := client.RunPoll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if received.OK || received.Code != "TASK_EXPIRED" {
		t.Fatalf("unexpected expired result: %#v", received)
	}
}

func TestExecuteTaskRejectsUnsafeIPRule(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(10000), "source": "10.0.0.0/8;uname", "table": float64(200)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsReservedIPRuleTable(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(10000), "source": "10.0.0.0/8", "table": float64(254)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsGatewayRuleOutsideMainTable(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(9000), "destination": "192.0.2.1/32", "table": float64(200)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsUnsafeGatewayDestination(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(9000), "destination": "192.0.2.1;uname/32", "table": float64(254)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsMismatchedIPRuleKind(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(9000), "kind": "gateway", "source": "192.0.2.0/24", "table": float64(200)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteTaskRejectsMappedIPv6IPRule(t *testing.T) {
	result := executeTask(context.Background(), task{TaskID: "t", NodeID: "n", Method: "network.ip_rules", Params: map[string]any{
		"removeRules": []any{},
		"rules":       []any{map[string]any{"priority": float64(10000), "source": "::ffff:192.0.2.0/120", "table": float64(200)}},
	}})
	if result.OK || result.Code != "INVALID_IP_RULE" {
		t.Fatalf("unexpected result: %#v", result)
	}
}
