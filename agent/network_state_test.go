package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type fakeIPKernel struct {
	rules       []map[string]any
	mutations   int
	failAdds    int
	failDeletes bool
}

func (k *fakeIPKernel) run(_ context.Context, args []string) commandResult {
	if strings.Join(args, " ") == "-j -4 rule show" {
		data, _ := json.Marshal(k.rules)
		return commandResult{ok: true, stdout: string(data)}
	}
	if strings.Join(args, " ") == "-4 route flush cache" {
		return commandResult{ok: true}
	}
	if len(args) != 11 {
		return commandResult{stderr: fmt.Sprintf("unexpected arguments: %v", args)}
	}
	priority, _ := strconv.Atoi(args[4])
	table, _ := strconv.Atoi(args[10])
	if args[10] == "main" {
		table = 254
	}
	value := map[string]any{"priority": float64(priority), "table": float64(table)}
	if args[6] != "all" {
		value["source"] = args[6]
	}
	if args[8] != "all" {
		value["destination"] = args[8]
	}
	rule, err := parseIPRule(value)
	if err != nil {
		return commandResult{stderr: err.Error()}
	}
	if args[2] == "add" {
		if k.failAdds > 0 {
			k.failAdds--
			return commandResult{stderr: "simulated add failure"}
		}
		k.mutations++
		k.rules = append(k.rules, ruleJSON(rule))
		return commandResult{ok: true}
	}
	if k.failDeletes {
		return commandResult{stderr: "simulated delete permission failure"}
	}
	for index, raw := range k.rules {
		data, _ := json.Marshal(raw)
		var parsed map[string]json.RawMessage
		_ = json.Unmarshal(data, &parsed)
		if found, ok := installedIPRule(parsed); ok && found == rule {
			k.mutations++
			k.rules = append(k.rules[:index], k.rules[index+1:]...)
			return commandResult{ok: true}
		}
	}
	return commandResult{stderr: "No such file or directory"}
}

func ruleJSON(rule ipRuleInput) map[string]any {
	source := rule.Source
	if source == "" {
		source = "all"
	}
	raw := map[string]any{"priority": rule.Priority, "src": source, "table": rule.Table}
	if rule.Destination != "" {
		raw["dst"] = rule.Destination
	}
	return raw
}

func setupIPRuleManager(t *testing.T) (ipRuleManager, *fakeIPKernel) {
	t.Helper()
	kernel := &fakeIPKernel{rules: []map[string]any{}}
	return ipRuleManager{path: filepath.Join(t.TempDir(), "state", "rules.json"), nodeID: "test-node", run: kernel.run}, kernel
}

var testSourceRule = ipRuleInput{Priority: 10000, Source: "198.18.0.1/32", Table: 200}
var testGatewayRule = ipRuleInput{Priority: 9000, Destination: "192.0.2.1/32", Table: 254}

func TestIPRulesPersistRestoreUpdateDelete(t *testing.T) {
	m, kernel := setupIPRuleManager(t)
	ctx := context.Background()
	rules := []ipRuleInput{testGatewayRule, testSourceRule}
	if err := m.apply(ctx, nil, append(rules, testSourceRule)); err != nil {
		t.Fatal(err)
	}
	state, err := m.read()
	if err != nil || !reflect.DeepEqual(state.Rules, rules) || len(state.Cleanup) != 0 {
		t.Fatalf("unexpected persisted state: %+v, %v", state, err)
	}
	info, _ := os.Stat(m.path)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("rule state must be private: %o", info.Mode().Perm())
	}
	// Restart with missing/duplicated rules. A different priority is untouched.
	unrelated := ipRuleInput{Priority: 20000, Source: "203.0.113.0/24", Table: 300}
	kernel.rules = []map[string]any{ruleJSON(unrelated), ruleJSON(testSourceRule), ruleJSON(testSourceRule)}
	if err := m.restore(ctx); err != nil {
		t.Fatal(err)
	}
	if len(kernel.rules) != 3 || !reflect.DeepEqual(kernel.rules[0], ruleJSON(unrelated)) {
		t.Fatalf("restart must deduplicate owned rules and retain unrelated rules: %+v", kernel.rules)
	}
	updated := testSourceRule
	updated.Source, updated.Table = "198.18.0.2/32", 201
	if err := m.apply(ctx, rules, []ipRuleInput{testGatewayRule, updated}); err != nil {
		t.Fatal(err)
	}
	state, _ = m.read()
	if !reflect.DeepEqual(state.Rules, []ipRuleInput{testGatewayRule, updated}) {
		t.Fatalf("updated rules not durable: %+v", state)
	}
	if err := m.apply(ctx, state.Rules, []ipRuleInput{}); err != nil {
		t.Fatal(err)
	}
	if err := m.restore(ctx); err != nil {
		t.Fatal(err)
	}
	state, _ = m.read()
	if len(state.Rules) != 0 || len(kernel.rules) != 1 {
		t.Fatalf("disabled/deleted rules resurrected: state=%+v kernel=%+v", state, kernel.rules)
	}
}

func TestIPRuleFailedApplyRestoresAcknowledgedSnapshot(t *testing.T) {
	m, kernel := setupIPRuleManager(t)
	ctx := context.Background()
	if err := m.apply(ctx, nil, []ipRuleInput{testSourceRule}); err != nil {
		t.Fatal(err)
	}
	kernel.failAdds = 1
	updated := testSourceRule
	updated.Source = "198.18.0.2/32"
	if err := m.apply(ctx, nil, []ipRuleInput{updated}); err == nil || !strings.Contains(err.Error(), "simulated add failure") {
		t.Fatalf("expected add failure: %v", err)
	}
	state, _ := m.read()
	if !reflect.DeepEqual(state.Rules, []ipRuleInput{testSourceRule}) || len(state.Cleanup) != 0 || !reflect.DeepEqual(kernel.rules, []map[string]any{ruleJSON(testSourceRule)}) {
		t.Fatalf("failed apply left candidate rules active or persisted: %+v, %+v", state, kernel.rules)
	}
	kernel.failDeletes = true
	if err := m.apply(ctx, nil, []ipRuleInput{updated}); err == nil || !strings.Contains(err.Error(), "delete permission failure") {
		t.Fatalf("delete failures must not be ignored: %v", err)
	}
	state, _ = m.read()
	if len(state.Cleanup) == 0 || !reflect.DeepEqual(state.Rules, []ipRuleInput{testSourceRule}) {
		t.Fatalf("failed rollback must leave a durable recovery journal: %+v", state)
	}
	kernel.failDeletes = false
	if err := m.restore(ctx); err != nil {
		t.Fatal(err)
	}
	state, _ = m.read()
	if len(state.Cleanup) != 0 {
		t.Fatalf("successful recovery did not clear pending cleanup: %+v", state)
	}
}

func TestIPRuleRestartRecoversInterruptedMutation(t *testing.T) {
	m, kernel := setupIPRuleManager(t)
	updated := testSourceRule
	updated.Source = "198.18.0.2/32"
	pending := ipRuleState{Version: 1, NodeID: m.nodeID, Rules: []ipRuleInput{testSourceRule}, Cleanup: []ipRuleInput{testSourceRule, testGatewayRule, updated}}
	if err := m.save(pending); err != nil {
		t.Fatal(err)
	}
	kernel.rules = []map[string]any{ruleJSON(testGatewayRule), ruleJSON(updated)}
	if err := m.restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(kernel.rules, []map[string]any{ruleJSON(testSourceRule)}) {
		t.Fatalf("interrupted candidate survived restart: %+v", kernel.rules)
	}
	state, _ := m.read()
	if len(state.Cleanup) != 0 {
		t.Fatal("cleanup journal not cleared")
	}
}

func TestIPRuleRecoveryValidatesEntireStateBeforeCommands(t *testing.T) {
	for _, data := range []string{
		`{`,
		`{"version":2,"nodeId":"test-node","rules":[]}`,
		`{"version":1,"nodeId":"other-node","rules":[]}`,
		`{"version":1,"nodeId":"test-node"}`,
		`{"nodeId":"test-node","rules":[]}`,
		`{"version":1,"nodeId":"test-node","rules":[{"priority":10000,"source":"198.18.0.1/32;id","table":200}]}`,
		`{"version":1,"nodeId":"test-node","rules":[]} {}`,
	} {
		t.Run(data, func(t *testing.T) {
			m, _ := setupIPRuleManager(t)
			if err := os.MkdirAll(filepath.Dir(m.path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(m.path, []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			m.run = func(context.Context, []string) commandResult {
				t.Fatal("invalid saved state executed a command")
				return commandResult{}
			}
			if err := m.restore(context.Background()); err == nil {
				t.Fatal("invalid state accepted")
			}
		})
	}
}

func TestIPRulePersistenceFailureDoesNotTouchKernel(t *testing.T) {
	m, _ := setupIPRuleManager(t)
	m.run = func(context.Context, []string) commandResult {
		t.Fatal("unsaved candidate changed kernel")
		return commandResult{}
	}
	if err := m.restore(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Dir(m.path), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.apply(context.Background(), nil, []ipRuleInput{testSourceRule}); err == nil {
		t.Fatal("persistence failure accepted")
	}
}

func TestIPRulePriorityCollisionPreservesUnmanagedSelectors(t *testing.T) {
	for _, extra := range []map[string]any{{"fwmark": "0x1"}, {"dst": "203.0.113.0/24"}, {"iif": "eth0"}, {"flags": []string{"not"}}} {
		m, kernel := setupIPRuleManager(t)
		raw := ruleJSON(testSourceRule)
		for key, value := range extra {
			raw[key] = value
		}
		kernel.rules = []map[string]any{raw}
		if err := m.apply(context.Background(), nil, []ipRuleInput{testSourceRule}); err == nil || !strings.Contains(err.Error(), "conflicts with an unmanaged rule") {
			t.Fatalf("expected collision rejection: %v", err)
		}
		if kernel.mutations != 0 {
			t.Fatalf("unmanaged rule altered: %+v", kernel.rules)
		}
	}
}

func TestIPRuleListingHandlesAllSourcesAndCanonicalAddresses(t *testing.T) {
	for _, source := range []string{"all", "0.0.0.0/0", "198.18.0.1", "198.18.0.99/24"} {
		data, _ := json.Marshal(map[string]any{"priority": 10000, "src": source, "table": "200"})
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(data, &raw)
		rule, valid := installedIPRule(raw)
		if !valid || rule.Source == "" {
			t.Fatalf("valid installed IPv4 source rule rejected: %+v", raw)
		}
	}
}

func TestPolicyInspectionRejectsUnstructuredOrUnsafeSelectors(t *testing.T) {
	for _, params := range []map[string]any{
		{"tables": []any{"200; id"}, "priorities": []any{}},
		{"tables": []any{float64(254)}, "priorities": []any{}},
		{"tables": []any{float64(200)}, "priorities": []any{float64(32766)}},
		{"tables": []any{float64(200.5)}, "priorities": []any{}},
	} {
		result := executeTask(context.Background(), task{NodeID: "test-node", Method: "network.ip_rules.inspect", Params: params})
		if result.OK || result.Code != "INVALID_IP_RULE_INSPECTION" {
			t.Fatalf("unsafe inspection accepted: %+v", result)
		}
	}
	if !readOnlyTask("network.ip_rules.inspect") || readOnlyTask("network.ip_rules") {
		t.Fatal("inspection and mutation must remain distinct operations")
	}
}

func TestIPRuleRecoveryReadsBusyBoxTextAndKeepsUnsupportedSelectors(t *testing.T) {
	m, _ := setupIPRuleManager(t)
	m.run = func(_ context.Context, args []string) commandResult {
		if args[0] == "-j" {
			return commandResult{stderr: "ip: invalid option -- j"}
		}
		return commandResult{ok: true, stdout: "0: from all lookup local\n9000: from all to 192.0.2.1 lookup main\n10000: from 198.18.0.1 lookup 200\n11000: not from all fwmark 0x1 lookup 201\n32766: from all lookup main\n"}
	}
	rules, err := m.list(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 5 {
		t.Fatalf("unexpected parsed rules: %+v", rules)
	}
	if rule, ok := installedIPRule(rules[1]); !ok || rule != testGatewayRule {
		t.Fatalf("gateway not parsed: %+v", rule)
	}
	if rule, ok := installedIPRule(rules[2]); !ok || rule != testSourceRule {
		t.Fatalf("source not parsed: %+v", rule)
	}
	if _, ok := installedIPRule(rules[3]); ok {
		t.Fatal("unsupported selectors must remain unmanaged")
	}
	if _, err := parseTextIPRules("not a policy rule"); err == nil {
		t.Fatal("malformed output must not be treated as empty rules")
	}
}

func TestTextKernelRoutesRetainDefaultBlackholeAndMultipathDetails(t *testing.T) {
	routes, err := parseTextIPRoutes("default via 192.0.2.1 dev lab0 proto bird\nblackhole 198.51.100.0/24 proto bird\n203.0.113.0/24 proto bird\n nexthop via 192.0.2.2 dev lab0 weight 1\n nexthop via 192.0.2.3 dev lab0 weight 2\n")
	if err != nil || len(routes) != 3 {
		t.Fatalf("unexpected routes: %s, %v", routes, err)
	}
	if !strings.Contains(string(routes[0]), `"gateway":"192.0.2.1"`) || !strings.Contains(string(routes[1]), `"type":"blackhole"`) || !strings.Contains(string(routes[2]), "weight 2") {
		t.Fatalf("route details lost: %s", routes)
	}
}
