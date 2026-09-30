import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHttpApplication } from "../src/http/application.js";
import { AgentBroker } from "../src/agent-broker.js";
import { AuthStore } from "../src/auth.js";
import { MemoryDatabase } from "../src/database.js";

test("HTTP server keeps long-running deployment requests beyond the old 60 second timeout", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "birdbox-http-timeout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "index.html"), "ok\n");
  const database = new MemoryDatabase();
  await database.initialize();
  const authStore = new AuthStore({ database, dataDir: root });
  await authStore.initialize();
  const broker = new AgentBroker({ database });
  await broker.initialize();
  const app = await createHttpApplication({
    publicDirectory: root,
    appVersion: "test",
    authStore,
    store: {},
    secureCookieSetting: false,
    ping: async () => true,
    isDeploymentLocked: () => false,
    loadDashboard: async () => ({ inventory: {}, events: [] }),
    withDeploymentLock: async (operation) => operation(),
    withNodeOperationLock: async (_nodeId, operation) => operation(),
    mutationService: {},
    addEvent: () => ({ timestamp: "", level: "info", message: "", nodeId: null }),
    getEvents: () => [],
    agentBroker: broker,
    database,
  });
  app.get("/test/slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { ok: true };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  context.after(() => app.close());
  assert.equal(app.server.requestTimeout, 0);
  assert.equal(app.server.timeout, 0);
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/test/slow`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
