package main

// Restricted kernel policy-routing operations for source-policy resources.
// Values are validated and passed as exec arguments; no shell is involved.

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

type ipRuleInput struct {
	priority    int64
	source      string
	destination string
	table       int64
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
		return ipRuleInput{priority: priority, source: s, table: table}, nil
	}
	if strings.ContainsAny(d, " \t\r\n'\"") || strings.Contains(d, ":") {
		return ipRuleInput{}, fmt.Errorf("invalid destination CIDR")
	}
	ip, network, err := net.ParseCIDR(d)
	if err != nil || ip.To4() == nil || network.IP.To4() == nil || table != 254 {
		return ipRuleInput{}, fmt.Errorf("gateway destination rule must use the IPv4 main table")
	}
	return ipRuleInput{priority: priority, destination: d, table: table}, nil
}

func ipRuleArgs(action string, rule ipRuleInput) []string {
	selector := "from"
	value := rule.source
	if rule.destination != "" {
		selector, value = "to", rule.destination
	}
	table := strconv.FormatInt(rule.table, 10)
	if rule.table == 254 {
		table = "main"
	}
	return []string{"-4", "rule", action, "priority", strconv.FormatInt(rule.priority, 10), selector, value, "table", table}
}

func networkIPRulesTask(parent context.Context, params map[string]any, r result) result {
	removed, okRemoved := params["removeRules"].([]any)
	desired, okDesired := params["rules"].([]any)
	if !okRemoved || !okDesired || len(removed) > 4096 || len(desired) > 4096 {
		r.Stderr, r.Code = "rules must be arrays", "INVALID_IP_RULES"
		return r
	}
	remove := make([]ipRuleInput, 0, len(removed)+len(desired))
	for _, value := range append(removed, desired...) {
		rule, err := parseIPRule(value)
		if err != nil {
			r.Stderr, r.Code = err.Error(), "INVALID_IP_RULE"
			return r
		}
		remove = append(remove, rule)
	}
	rules := make([]ipRuleInput, 0, len(desired))
	for _, value := range desired {
		rule, _ := parseIPRule(value)
		rules = append(rules, rule)
	}
	var out, errOut strings.Builder
	r.OK = true
	for _, rule := range remove {
		result := runCommand(parent, "ip", ipRuleArgs("del", rule), 15*time.Second, 256*1024)
		out.WriteString(result.stdout)
		errOut.WriteString(result.stderr)
	}
	for _, rule := range rules {
		result := runCommand(parent, "ip", ipRuleArgs("add", rule), 15*time.Second, 256*1024)
		out.WriteString(result.stdout)
		errOut.WriteString(result.stderr)
		if !result.ok {
			r.OK, r.Code = false, result.code
			break
		}
	}
	if flush := runCommand(parent, "ip", []string{"route", "flush", "cache"}, 15*time.Second, 64*1024); !flush.ok {
		errOut.WriteString(flush.stderr)
	}
	r.Stdout, r.Stderr = out.String(), strings.TrimSpace(errOut.String())
	if r.OK {
		r.Stderr = ""
	}
	return r
}
