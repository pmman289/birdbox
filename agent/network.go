package main

// Restricted kernel policy-routing operations for source-policy resources.
// Values are validated and passed as exec arguments; no shell is involved.

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
)

type ipRuleInput struct {
	Priority    int64  `json:"priority"`
	Source      string `json:"source,omitempty"`
	Destination string `json:"destination,omitempty"`
	Table       int64  `json:"table"`
}

func parseIPRule(value any) (ipRuleInput, error) {
	raw, ok := value.(map[string]any)
	if !ok {
		return ipRuleInput{}, fmt.Errorf("rule must be an object")
	}
	p, pok := raw["priority"].(float64)
	t, tok := raw["table"].(float64)
	s, sourceOK := raw["source"].(string)
	d, destinationOK := raw["destination"].(string)
	kind, kindOK := raw["kind"].(string)
	if !pok || !tok || p != float64(int64(p)) || t != float64(int64(t)) {
		return ipRuleInput{}, fmt.Errorf("invalid rule fields")
	}
	if sourceOK == destinationOK || (!sourceOK && !destinationOK) {
		return ipRuleInput{}, fmt.Errorf("exactly one rule selector is required")
	}
	if kindOK && ((kind != "source" && kind != "gateway") || (kind == "source" && !sourceOK) || (kind == "gateway" && !destinationOK)) {
		return ipRuleInput{}, fmt.Errorf("rule kind does not match selector")
	}
	priority, table := int64(p), int64(t)
	if priority < 1 || priority > 32765 || table < 1 || table > 2147483647 || table == 253 || table == 255 {
		return ipRuleInput{}, fmt.Errorf("rule priority or table out of range")
	}
	if sourceOK {
		if strings.ContainsAny(s, " \t\r\n'\"") || strings.Contains(s, ":") {
			return ipRuleInput{}, fmt.Errorf("invalid source CIDR")
		}
		ip, network, err := net.ParseCIDR(s)
		if err != nil || ip.To4() == nil || network.IP.To4() == nil || table == 254 {
			return ipRuleInput{}, fmt.Errorf("invalid source CIDR rule")
		}
		return ipRuleInput{Priority: priority, Source: network.String(), Table: table}, nil
	}
	if strings.ContainsAny(d, " \t\r\n'\"") || strings.Contains(d, ":") {
		return ipRuleInput{}, fmt.Errorf("invalid destination CIDR")
	}
	ip, network, err := net.ParseCIDR(d)
	if err != nil || ip.To4() == nil || network.IP.To4() == nil || table != 254 {
		return ipRuleInput{}, fmt.Errorf("gateway destination rule must use the IPv4 main table")
	}
	return ipRuleInput{Priority: priority, Destination: network.String(), Table: table}, nil
}

func ipRuleArgs(action string, rule ipRuleInput) []string {
	from, to := rule.Source, rule.Destination
	if from == "" {
		from = "all"
	}
	if to == "" {
		to = "all"
	}
	table := strconv.FormatInt(rule.Table, 10)
	if rule.Table == 254 {
		table = "main"
	}
	return []string{"-4", "rule", action, "priority", strconv.FormatInt(rule.Priority, 10), "from", from, "to", to, "table", table}
}

func networkIPRulesTask(parent context.Context, params map[string]any, r result) result {
	removed, okRemoved := params["removeRules"].([]any)
	desired, okDesired := params["rules"].([]any)
	if !okRemoved || !okDesired || len(removed) > maxManagedIPRules || len(desired) > maxManagedIPRules {
		r.Stderr, r.Code = "rules must be arrays of at most 4096 entries", "INVALID_IP_RULES"
		return r
	}
	parse := func(values []any) ([]ipRuleInput, error) {
		rules := make([]ipRuleInput, 0, len(values))
		for _, value := range values {
			rule, err := parseIPRule(value)
			if err != nil {
				return nil, err
			}
			rules = append(rules, rule)
		}
		return uniqueIPRules(rules), nil
	}
	remove, err := parse(removed)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_IP_RULE"
		return r
	}
	rules, err := parse(desired)
	if err != nil {
		r.Stderr, r.Code = err.Error(), "INVALID_IP_RULE"
		return r
	}
	manager := newIPRuleManager(r.NodeID)
	ipRulesMutex.Lock()
	defer ipRulesMutex.Unlock()
	if err := manager.apply(parent, remove, rules); err != nil {
		r.Stderr, r.Code = err.Error(), "IP_RULES_FAILED"
		return r
	}
	r.OK, r.Stdout = true, "IPv4 policy rules applied and saved for restart recovery"
	return r
}
