package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

func parseTextIPRules(source string) ([]map[string]json.RawMessage, error) {
	rules := make([]map[string]json.RawMessage, 0)
	for _, line := range strings.Split(strings.TrimSpace(source), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		priority, err := strconv.ParseInt(strings.TrimSuffix(fields[0], ":"), 10, 64)
		if err != nil || !strings.HasSuffix(fields[0], ":") {
			return nil, fmt.Errorf("cannot parse policy rule: %s", line)
		}
		raw := map[string]any{"priority": priority}
		for index := 1; index < len(fields); index++ {
			var name string
			switch fields[index] {
			case "from":
				name = "src"
			case "to":
				name = "dst"
			case "lookup", "table":
				name = "table"
			case "proto", "protocol":
				name = "protocol"
			default:
				// Retain evidence of any selectors outside our managed tuple. A
				// colliding priority then blocks deletion instead of hiding it.
				raw["unsupported"] = line
				continue
			}
			index++
			if index >= len(fields) {
				return nil, fmt.Errorf("incomplete policy rule: %s", line)
			}
			raw[name] = fields[index]
		}
		data, _ := json.Marshal(raw)
		var result map[string]json.RawMessage
		_ = json.Unmarshal(data, &result)
		rules = append(rules, result)
	}
	return rules, nil
}

func parseTextIPRoutes(source string) ([]json.RawMessage, error) {
	routes := make([]json.RawMessage, 0)
	var current map[string]any
	flush := func() {
		if current != nil {
			data, _ := json.Marshal(current)
			routes = append(routes, data)
			current = nil
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(source), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "nexthop" {
			if current == nil {
				return nil, fmt.Errorf("kernel nexthop without route")
			}
			current["raw"] = current["raw"].(string) + "\n" + line
			continue
		}
		flush()
		current = map[string]any{"raw": line}
		index := 0
		switch fields[0] {
		case "blackhole", "unreachable", "prohibit", "throw", "local", "broadcast":
			current["type"] = fields[0]
			index++
		}
		if index >= len(fields) {
			return nil, fmt.Errorf("incomplete kernel route")
		}
		current["dst"] = fields[index]
		for index++; index+1 < len(fields); index++ {
			switch fields[index] {
			case "via":
				current["gateway"] = fields[index+1]
				index++
			case "dev":
				current["dev"] = fields[index+1]
				index++
			case "proto":
				current["protocol"] = fields[index+1]
				index++
			}
		}
	}
	flush()
	return routes, nil
}
