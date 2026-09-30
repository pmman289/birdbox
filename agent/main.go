package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

var version = "0.1.0"
var buildArch = ""

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Println(version)
		return
	}
	if os.Geteuid() != 0 {
		log.Fatal("birdbox-agent must run as root")
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	transport, err := buildTransport()
	if err != nil {
		log.Fatal(err)
	}
	upgradeHTTPClient = &http.Client{Timeout: 10 * time.Minute, Transport: transport}
	client := NewClientWithTransport(cfg, transport)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	backoff := time.Second
	registered := false
	unauthorized := 0
	for ctx.Err() == nil {
		if !registered {
			if err := client.Register(ctx, version); err != nil {
				if errors.Is(err, ErrUnauthorized) {
					unauthorized++
					// Keep retrying instead of exiting into a systemd/procd restart
					// loop while the controller is recovering or credentials rotate.
					if unauthorized == 1 || unauthorized%20 == 0 {
						log.Printf("controller rejected agent credentials; retrying (attempt %d)", unauthorized)
					}
				}
				log.Printf("controller unavailable: %v", err)
				if !sleepContext(ctx, backoff) {
					return
				}
				if backoff < 30*time.Second {
					backoff *= 2
				}
				continue
			}
			registered = true
			unauthorized = 0
			backoff = time.Second
		}
		if err := client.RunPoll(ctx); err != nil {
			registered = false
			if errors.Is(err, ErrUnauthorized) {
				log.Printf("agent unauthorized; retrying with backoff: %v", err)
			}
			log.Printf("polling stopped: %v", err)
			if !sleepContext(ctx, backoff) {
				return
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
		}
	}
}

func reportedArchitecture() string {
	if buildArch != "" {
		return buildArch
	}
	return runtime.GOARCH
}

func buildTransport() (*http.Transport, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	caFile := strings.TrimSpace(os.Getenv("BIRDBOX_CONTROLLER_CA_FILE"))
	if caFile == "" {
		return transport, nil
	}
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("no certificates in %s", caFile)
	}
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	return transport, nil
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
	t := time.NewTimer(duration)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

type Config struct{ ControllerURL, NodeID, Token string }

func loadConfig() (Config, error) {
	get := func(name string) string { return strings.TrimSpace(os.Getenv(name)) }
	cfg := Config{ControllerURL: strings.TrimRight(get("BIRDBOX_CONTROLLER_URL"), "/"), NodeID: get("BIRDBOX_NODE_ID"), Token: get("BIRDBOX_AGENT_TOKEN")}
	if cfg.ControllerURL == "" || cfg.NodeID == "" || cfg.Token == "" {
		return cfg, fmt.Errorf("BIRDBOX_CONTROLLER_URL, BIRDBOX_NODE_ID and BIRDBOX_AGENT_TOKEN are required")
	}
	if !strings.HasPrefix(cfg.ControllerURL, "http://") && !strings.HasPrefix(cfg.ControllerURL, "https://") {
		return cfg, fmt.Errorf("BIRDBOX_CONTROLLER_URL must use http or https")
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("BIRDBOX_AGENT_REQUIRE_HTTPS")), "true") && !strings.HasPrefix(cfg.ControllerURL, "https://") {
		return cfg, fmt.Errorf("BIRDBOX_CONTROLLER_URL must use https when BIRDBOX_AGENT_REQUIRE_HTTPS=true")
	}
	return cfg, nil
}

func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
