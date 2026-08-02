import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthStore } from "../src/auth.js";
import { createDatabaseFromEnvironment } from "../src/database.js";
import { InventoryStore } from "../src/store.js";

const mysqlUrl = process.env.BIRDBOX_TEST_MYSQL_URL;

test("persists inventory, revision conflicts, and multi-session auth in MySQL", {
  skip: !mysqlUrl,
}, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-mysql-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const database = createDatabaseFromEnvironment({
    NODE_ENV: "integration",
    BIRDBOX_DATABASE_URL: mysqlUrl,
    BIRDBOX_DB_POOL_SIZE: "1",
    BIRDBOX_DB_CONNECT_RETRIES: "3",
    BIRDBOX_DB_CONNECT_RETRY_MS: "100",
  });
  context.after(() => database.close());
  await database.initialize();
  assert.equal(database.connectionLimit, 2);

  const stateKey = `it_${process.pid}_${Date.now()}`;
  await database.createState(stateKey, { count: 0 });
  const initial = await database.readState(stateKey);
  const stateReadWhileLocked = await database.withLock(`nested_read_${process.pid}_${Date.now()}`, () => database.readState(stateKey));
  assert.deepEqual(stateReadWhileLocked, initial);
  const mutation = await database.mutateState(stateKey, { count: 0 }, async (current) => ({
    value: { count: current.count + 1 },
    result: "updated",
  }));
  assert.equal(mutation.result, "updated");
  assert.equal(mutation.value.count, 1);
  assert.equal(mutation.revision, initial.revision + 1);
  const unchanged = await database.mutateState(stateKey, { count: 0 }, async () => ({ result: "unchanged" }));
  assert.equal(unchanged.result, "unchanged");
  assert.equal(unchanged.revision, mutation.revision);
  await assert.rejects(
    () => database.replaceState(stateKey, initial.revision, { count: 99 }),
    (error) => error.code === "STATE_CONFLICT" && error.status === 409,
  );

  let signalLocked;
  let releaseLock;
  const locked = new Promise((resolve) => { signalLocked = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });
  const lockName = `deployment_${process.pid}_${Date.now()}`;
  const firstLock = database.withLock(lockName, async () => {
    signalLocked();
    await hold;
  });
  await locked;
  try {
    await assert.rejects(
      () => database.withLock(lockName, async () => undefined),
      (error) => error.code === "DEPLOYMENT_LOCKED" && error.status === 409,
    );
  } finally {
    releaseLock();
    await firstLock;
  }

  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, "inventory.json"), JSON.stringify({
    version: 17,
    nodes: [],
    peers: [],
    defines: [],
    functions: [],
    filters: [],
    rpki: [],
    sessions: [],
  }));
  const inventoryKey = `inventory_it_${process.pid}_${Date.now()}`;
  const firstStore = new InventoryStore({
    database,
    dataDir,
    nodesPath: path.join(root, "missing-nodes.json"),
    legacySessionPath: path.join(root, "missing-session.json"),
    stateKey: inventoryKey,
  });
  const firstInventory = await firstStore.read();
  const secondStore = new InventoryStore({
    database,
    dataDir,
    nodesPath: path.join(root, "missing-nodes.json"),
    legacySessionPath: path.join(root, "missing-session.json"),
    stateKey: inventoryKey,
  });
  assert.deepEqual(await secondStore.read(), firstInventory);

  const authKey = `auth_it_${process.pid}_${Date.now()}`;
  const firstAuth = new AuthStore({ database, dataDir, stateKey: authKey });
  const token = await firstAuth.setup("mysql-integration-password", "mysql-integration-password");
  assert.equal((await firstAuth.status(token)).authenticated, true);
  await fs.writeFile(path.join(dataDir, "auth.json"), "not-json");
  const secondAuth = new AuthStore({ database, dataDir, stateKey: authKey });
  assert.equal((await secondAuth.status(token)).authenticated, true);
  const replacementToken = await secondAuth.login("mysql-integration-password");
  assert.notEqual(replacementToken, token);
  assert.equal((await secondAuth.status(token)).authenticated, true);
  assert.equal((await secondAuth.status(replacementToken)).authenticated, true);
  assert.equal((await secondAuth.revokeOtherSessions(replacementToken)), 1);
  assert.equal((await secondAuth.status(token)).authenticated, false);
  assert.equal((await secondAuth.status(replacementToken)).authenticated, true);

  const futureVersion = 2147483647;
  let incompatibleDatabase;
  await database.pool.execute(
    "INSERT INTO birdbox_schema_migrations (version, name) VALUES (?, ?)",
    [futureVersion, "future_test_schema"],
  );
  try {
    incompatibleDatabase = createDatabaseFromEnvironment({
      NODE_ENV: "integration",
      BIRDBOX_DATABASE_URL: mysqlUrl,
      BIRDBOX_DB_POOL_SIZE: "1",
      BIRDBOX_DB_CONNECT_RETRIES: "1",
      BIRDBOX_DB_CONNECT_RETRY_MS: "0",
    });
    await assert.rejects(
      () => incompatibleDatabase.initialize(),
      (error) => error.code === "DATABASE_SCHEMA_TOO_NEW" && error.status === 409,
    );
  } finally {
    await incompatibleDatabase?.close();
    await database.pool.execute("DELETE FROM birdbox_schema_migrations WHERE version = ?", [futureVersion]);
  }
});
