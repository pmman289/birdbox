package main

import (
	"os"
	"path/filepath"
	"strings"
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
