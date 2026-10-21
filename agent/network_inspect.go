package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func inspectIPRulesTask(ctx context.Context, params map[string]any, r result) result {
	integers := func(value any, limit int, valid func(int64) bool) ([]int64, error) {
		items, ok := value.([]any)
		if !ok || len(items) > limit {
			return nil, fmt.Errorf("invalid policy inspection scope")
		}
		values := make([]int64, 0, len(items))
		for _, item := range items {
			number, ok := item.(float64)
			if !ok || number != float64(int64(number)) || !valid(int64(number)) {
				return nil, fmt.Errorf("invalid policy inspection selector")
			}
			values = append(values, int64(number))
		}
		return values, nil
	}
	tables, err := integers(params["tables"], 64, func(n int64) bool { return n > 0 && n <= 2147483647 && n != 253 && n != 254 && n != 255 })
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_IP_RULE_INSPECTION"
		return r
	}
	priorities, err := integers(params["priorities"], maxManagedIPRules, func(n int64) bool { return n > 0 && n <= 32765 })
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_IP_RULE_INSPECTION"
		return r
	}
	m := newIPRuleManager(r.NodeID)
	rawRules, err := m.list(ctx)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "IP_RULE_INSPECTION_FAILED"
		return r
	}
	wanted := make(map[int64]bool)
	for _, priority := range priorities {
		wanted[priority] = true
	}
	rules := make([]ipRuleInput, 0)
	raw := make([]map[string]json.RawMessage, 0)
	for _, value := range rawRules {
		var priority int64
		_ = json.Unmarshal(value["priority"], &priority)
		if !wanted[priority] {
			continue
		}
		if rule, valid := installedIPRule(value); valid {
			rules = append(rules, rule)
		}
		if len(raw) < 200 {
			raw = append(raw, value)
		}
	}
	type tableResult struct {
		Table     int64             `json:"table"`
		Routes    []json.RawMessage `json:"routes"`
		Truncated bool              `json:"truncated"`
		Error     *string           `json:"error"`
	}
	results := make([]tableResult, 0, len(tables))
	for _, table := range tables {
		entry := tableResult{Table: table, Routes: []json.RawMessage{}}
		output := m.run(ctx, []string{"-j", "-4", "route", "show", "table", strconv.FormatInt(table, 10)})
		if !output.ok && !strings.Contains(output.stderr, "FIB table does not exist") {
			text := m.run(ctx, []string{"-4", "route", "show", "table", strconv.FormatInt(table, 10)})
			if text.ok {
				routes, err := parseTextIPRoutes(text.stdout)
				if err == nil {
					data, _ := json.Marshal(routes)
					output = commandResult{ok: true, stdout: string(data)}
				}
			}
		}
		if !output.ok {
			if !strings.Contains(output.stderr, "FIB table does not exist") {
				message := strings.TrimSpace(output.stderr + output.stdout)
				entry.Error = &message
			}
		} else if err := json.Unmarshal([]byte(output.stdout), &entry.Routes); err != nil {
			message := "invalid kernel route response: " + err.Error()
			entry.Error = &message
		}
		if len(entry.Routes) > 200 {
			entry.Routes, entry.Truncated = entry.Routes[:200], true
		}
		results = append(results, entry)
	}
	persistence := map[string]any{"state": "ready", "rules": 0, "error": nil}
	if _, err := os.Stat(m.path); errors.Is(err, os.ErrNotExist) {
		persistence["state"] = "missing"
	} else if state, err := m.read(); err != nil {
		persistence["state"], persistence["error"] = "error", err.Error()
	} else {
		persistence["rules"] = len(state.Rules)
		if len(state.Cleanup) > 0 {
			persistence["state"] = "pending"
		}
	}
	data, err := json.Marshal(map[string]any{"rules": rules, "rawRules": raw, "tables": results, "persistence": persistence})
	if err != nil {
		r.Stderr, r.Code = err.Error(), "IP_RULE_INSPECTION_FAILED"
		return r
	}
	r.OK, r.Stdout = true, string(data)
	return r
}
