package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxManagedIPRules = 4096

var ipRulesMutex sync.Mutex

// Rules is the last locally committed snapshot. Cleanup is written before touching
// the kernel, so an interrupted operation can restore that snapshot on restart.
type ipRuleState struct {
	Version int           `json:"version"`
	NodeID  string        `json:"nodeId"`
	Rules   []ipRuleInput `json:"rules"`
	Cleanup []ipRuleInput `json:"cleanup,omitempty"`
}

type ipRuleManager struct {
	path   string
	nodeID string
	run    func(context.Context, []string) commandResult
}

func newIPRuleManager(nodeID string) ipRuleManager {
	path := strings.TrimSpace(os.Getenv("BIRDBOX_IP_RULES_STATE_PATH"))
	if path == "" {
		// /var is volatile on OpenWrt. The installer already creates /etc/birdbox.
		path = "/etc/birdbox/source-policy-rules.json"
	}
	return ipRuleManager{path: path, nodeID: nodeID, run: func(ctx context.Context, args []string) commandResult {
		return runCommand(ctx, "ip", args, 15*time.Second, 8*1024*1024)
	}}
}

func uniqueIPRules(groups ...[]ipRuleInput) []ipRuleInput {
	result := make([]ipRuleInput, 0)
	seen := make(map[ipRuleInput]bool)
	for _, rules := range groups {
		for _, rule := range rules {
			if !seen[rule] {
				result = append(result, rule)
				seen[rule] = true
			}
		}
	}
	return result
}

func validateSavedIPRules(rules []ipRuleInput, limit int) error {
	if len(rules) > limit {
		return fmt.Errorf("saved policy rule count exceeds %d", limit)
	}
	for _, rule := range rules {
		raw := map[string]any{"priority": float64(rule.Priority), "table": float64(rule.Table)}
		if rule.Source != "" {
			raw["source"] = rule.Source
		}
		if rule.Destination != "" {
			raw["destination"] = rule.Destination
		}
		parsed, err := parseIPRule(raw)
		if err != nil || parsed != rule {
			return fmt.Errorf("invalid saved policy rule: %v", err)
		}
	}
	return nil
}

func (m ipRuleManager) read() (ipRuleState, error) {
	state := ipRuleState{Version: 1, NodeID: m.nodeID, Rules: []ipRuleInput{}}
	file, err := os.Open(m.path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	defer file.Close()
	state = ipRuleState{}
	decoder := json.NewDecoder(io.LimitReader(file, 8*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return state, fmt.Errorf("read saved policy rules: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return state, fmt.Errorf("unexpected data after saved policy rules")
	}
	if state.Version != 1 || state.NodeID != m.nodeID || state.Rules == nil {
		return state, fmt.Errorf("saved policy rules have incompatible version or node ID")
	}
	if err := validateSavedIPRules(state.Rules, maxManagedIPRules); err != nil {
		return state, err
	}
	return state, validateSavedIPRules(state.Cleanup, maxManagedIPRules*4)
}

func (m ipRuleManager) save(state ipRuleState) error {
	if !absoluteSafePath(m.path) || m.nodeID == "" {
		return fmt.Errorf("invalid policy rules state path or node ID")
	}
	if err := validateSavedIPRules(state.Cleanup, maxManagedIPRules*4); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return atomicWrite(m.path, data, 0600, -1)
}

func (m ipRuleManager) list(ctx context.Context) ([]map[string]json.RawMessage, error) {
	result := m.run(ctx, []string{"-j", "-4", "rule", "show"})
	var rules []map[string]json.RawMessage
	if result.ok && json.Unmarshal([]byte(result.stdout), &rules) == nil {
		return rules, nil
	}
	// BusyBox ip on OpenWrt does not implement JSON output.
	text := m.run(ctx, []string{"-4", "rule", "show"})
	if !text.ok {
		return nil, fmt.Errorf("read IPv4 policy rules: %s", strings.TrimSpace(text.stderr+text.stdout))
	}
	return parseTextIPRules(text.stdout)
}

func installedIPRule(raw map[string]json.RawMessage) (ipRuleInput, bool) {
	// Additional selectors (fwmark, interfaces, ports, inversion, etc.) belong
	// to other tools and must not be removed by a less specific deletion.
	for key := range raw {
		if key != "priority" && key != "src" && key != "dst" && key != "table" && key != "protocol" {
			return ipRuleInput{}, false
		}
	}
	var priority int64
	if json.Unmarshal(raw["priority"], &priority) != nil {
		return ipRuleInput{}, false
	}
	var source, destination, table string
	_ = json.Unmarshal(raw["src"], &source)
	_ = json.Unmarshal(raw["dst"], &destination)
	if json.Unmarshal(raw["table"], &table) != nil {
		table = string(raw["table"])
	}
	if table == "main" {
		table = "254"
	}
	lookup, err := strconv.ParseInt(table, 10, 64)
	if err != nil {
		return ipRuleInput{}, false
	}
	value := map[string]any{"priority": float64(priority), "table": float64(lookup)}
	if source != "" && source != "all" && source != "0.0.0.0/0" {
		if !strings.Contains(source, "/") {
			source += "/32"
		}
		value["source"] = source
	}
	if destination != "" && destination != "all" && destination != "0.0.0.0/0" {
		if !strings.Contains(destination, "/") {
			destination += "/32"
		}
		value["destination"] = destination
	}
	// An explicit /0 source is still a valid managed source rule.
	if len(value) == 2 {
		if lookup == 254 {
			value["destination"] = "0.0.0.0/0"
		} else {
			value["source"] = "0.0.0.0/0"
		}
	}
	rule, err := parseIPRule(value)
	return rule, err == nil
}

func (m ipRuleManager) reconcile(ctx context.Context, cleanup, desired []ipRuleInput) error {
	installed, err := m.list(ctx)
	if err != nil {
		return err
	}
	remove := make(map[ipRuleInput]bool)
	priorities := make(map[int64]bool)
	for _, rule := range uniqueIPRules(cleanup, desired) {
		remove[rule] = true
		priorities[rule.Priority] = true
	}
	for _, raw := range installed {
		var priority int64
		_ = json.Unmarshal(raw["priority"], &priority)
		if !priorities[priority] {
			continue
		}
		if rule, valid := installedIPRule(raw); !valid || !remove[rule] {
			return fmt.Errorf("policy rule priority %d conflicts with an unmanaged rule; no rules changed", priority)
		}
	}
	for _, raw := range installed {
		rule, valid := installedIPRule(raw)
		if !valid || !remove[rule] {
			continue
		}
		if result := m.run(ctx, ipRuleArgs("del", rule)); !result.ok {
			return fmt.Errorf("remove IPv4 policy rule: %s", strings.TrimSpace(result.stderr+result.stdout))
		}
	}
	for _, rule := range uniqueIPRules(desired) {
		if result := m.run(ctx, ipRuleArgs("add", rule)); !result.ok {
			return fmt.Errorf("add IPv4 policy rule: %s", strings.TrimSpace(result.stderr+result.stdout))
		}
	}
	if result := m.run(ctx, []string{"-4", "route", "flush", "cache"}); !result.ok {
		return fmt.Errorf("flush IPv4 route cache: %s", strings.TrimSpace(result.stderr+result.stdout))
	}
	return nil
}

func (m ipRuleManager) apply(ctx context.Context, remove, desired []ipRuleInput) error {
	previous, err := m.read()
	if err != nil {
		return err
	}
	pending := previous
	pending.Cleanup = uniqueIPRules(previous.Cleanup, previous.Rules, remove, desired)
	if err := m.save(pending); err != nil {
		return fmt.Errorf("save policy rule recovery journal before applying: %w", err)
	}
	if err := m.reconcile(ctx, pending.Cleanup, desired); err != nil {
		if rollbackErr := m.reconcile(ctx, pending.Cleanup, previous.Rules); rollbackErr != nil {
			return fmt.Errorf("%w; rule rollback failed (restart recovery pending): %v", err, rollbackErr)
		}
		previous.Cleanup = nil
		if saveErr := m.save(previous); saveErr != nil {
			return fmt.Errorf("%w; save restored policy rules: %v", err, saveErr)
		}
		return err
	}
	committed := ipRuleState{Version: 1, NodeID: m.nodeID, Rules: uniqueIPRules(desired)}
	if err := m.save(committed); err != nil {
		// Never acknowledge an update that would disappear on reboot.
		rollbackErr := m.reconcile(ctx, pending.Cleanup, previous.Rules)
		if rollbackErr == nil {
			previous.Cleanup = nil
			rollbackErr = m.save(previous)
		}
		return fmt.Errorf("save applied policy rules: %w; rollback result: %v", err, rollbackErr)
	}
	return nil
}

func (m ipRuleManager) restore(ctx context.Context) error {
	if _, err := os.Stat(m.path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	state, err := m.read()
	if err != nil {
		return err
	}
	if err := m.reconcile(ctx, uniqueIPRules(state.Cleanup, state.Rules), state.Rules); err != nil {
		return err
	}
	if len(state.Cleanup) > 0 {
		state.Cleanup = nil
		return m.save(state)
	}
	return nil
}

func restoreIPRulesOnStartup(ctx context.Context, nodeID string) {
	restore := func() error {
		ipRulesMutex.Lock()
		defer ipRulesMutex.Unlock()
		bounded, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		return newIPRuleManager(nodeID).restore(bounded)
	}
	if err := restore(); err == nil {
		return
	} else {
		log.Printf("source policy rule recovery pending: %v", err)
	}
	// Keep the Agent reachable while a transient kernel/ip failure is retried.
	go func() {
		for sleepContext(ctx, 30*time.Second) {
			if err := restore(); err == nil {
				log.Print("source policy rules recovered")
				return
			} else {
				log.Printf("source policy rule recovery pending: %v", err)
			}
		}
	}()
}
