import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { MemoryDatabase } from "../src/database.js";
import { createHttpApplication } from "../src/http/application.js";
import { MetricsRegistry } from "../src/observability.js";

test("MemoryDatabase keeps a bounded persistent-style audit stream", async () => {
  const database = new MemoryDatabase();
  await database.appendAuditEvent({
    occurredAt: new Date().toISOString(), requestId: "req-1", actor: "admin", method: "PUT",
    path: "/api/ospf/domain", status: 200, outcome: "success", remoteAddress: "127.0.0.1",
    userAgent: "test", detail: null,
  });
  const events = await database.listAuditEvents(10);
  assert.equal(events.length, 1);
  assert.equal(events[0].path, "/api/ospf/domain");
  assert.equal(events[0].id, 1);
});

test("metrics render bounded labels and counters", () => {
  const metrics = new MetricsRegistry();
  metrics.observeRequest("GET", "/api/dashboard", 200, 25);
  metrics.observeRequest("POST", "/api/ospf/:id", 422, 100);
  const output = metrics.render();
  assert.match(output, /birdbox_http_requests_total\{method="GET",route="\/api\/dashboard",status_class="2xx"\} 1/);
  assert.match(output, /birdbox_http_requests_total\{method="POST",route="\/api\/ospf\/\:id",status_class="4xx"\} 1/);
  assert.match(output, /birdbox_http_request_duration_seconds_sum 0\.125000/);
});

test("HTTP mutations are auditable and Prometheus metrics are scrapeable", async (context) => {
  const database = new MemoryDatabase();
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"), appVersion: "test", authStore: { isAuthenticated: async () => true },
    store: { read: async () => ({ version: 28, nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [], ospfLayout: {} }) },
    secureCookieSetting: false, ping: async () => true, isDeploymentLocked: () => false,
    loadDashboard: async () => { throw new Error("not used"); },
    withDeploymentLock: async (operation) => operation(), withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {}, addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }), getEvents: () => [], agentBroker: {},
    database, metricsToken: "metrics-secret",
  });
  context.after(() => app.close());

  const mutation = await app.inject({ method: "POST", url: "/api/not-a-real-mutation", headers: { host: "localhost" } });
  assert.equal(mutation.statusCode, 404);
  const agentNoise = await app.inject({ method: "POST", url: "/api/agent/not-a-real-endpoint", headers: { host: "localhost" }, payload: {} });
  assert.equal(agentNoise.statusCode, 404);
  await new Promise((resolve) => setImmediate(resolve));
  const audit = await app.inject({ method: "GET", url: "/api/audit/events", headers: { host: "localhost" } });
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().events[0].path, "/api/not-a-real-mutation");
  assert.equal(audit.json().events.some((event) => event.path.startsWith("/api/agent/")), false);

  const unauthorized = await app.inject({ method: "GET", url: "/metrics" });
  assert.equal(unauthorized.statusCode, 401);
  const response = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-secret" } });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /birdbox_http_requests_total/);
});

test("unauthenticated API errors do not expose change events", async (context) => {
  const database = new MemoryDatabase();
  let eventWrites = 0;
  const app = await createHttpApplication({
    publicDirectory: path.resolve("public"), appVersion: "test",
    authStore: { isAuthenticated: async () => false },
    store: { read: async () => ({ version: 28, nodes: [], peers: [], defines: [], functions: [], filters: [], rpki: [], staticProtocols: [], directProtocols: [], kernelProtocols: [], sourcePolicies: [], sessions: [], ibgpDomains: [], ospfDomains: [], ospfLayout: {} }) },
    secureCookieSetting: false, ping: async () => true, isDeploymentLocked: () => false,
    loadDashboard: async () => { throw new Error("not used"); },
    withDeploymentLock: async (operation) => operation(), withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {}, addEvent: () => { eventWrites += 1; return { timestamp: "", level: "error", message: "secret", nodeId: null }; },
    getEvents: () => [{ timestamp: "", level: "error", message: "secret node details", nodeId: "secret-node" }], agentBroker: {}, database,
  });
  context.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { host: "localhost", "content-type": "application/json" }, payload: "{" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().events, undefined);
  assert.equal(eventWrites, 0);
});
