import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthStore } from "../src/auth.js";
import { MemoryDatabase } from "../src/database.js";

test("imports legacy auth once, invalidates its session, and does not resurrect it after reset", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-auth-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);

  const sourceDatabase = new MemoryDatabase();
  const source = new AuthStore({
    database: sourceDatabase,
    dataDir,
    stateKey: "legacy_source",
    legacyImportStateKey: "legacy_source_marker",
  });
  const legacyToken = await source.setup("legacy-admin-password", "legacy-admin-password");
  const legacy = await sourceDatabase.readState("legacy_source");
  await fs.writeFile(path.join(dataDir, "auth.json"), JSON.stringify(legacy.value));

  const database = new MemoryDatabase();
  const imported = new AuthStore({
    database,
    dataDir,
    stateKey: "auth",
    legacyImportStateKey: "auth_legacy_marker",
  });
  await imported.initialize();
  assert.equal((await imported.status(legacyToken)).configured, true);
  assert.equal((await imported.status(legacyToken)).authenticated, false);
  const replacementToken = await imported.login("legacy-admin-password");
  assert.ok(replacementToken);

  // A password recovery removes only auth state. The completed migration marker
  // remains, so an old JSON file cannot restore the prior password or session.
  database.states.delete("auth");
  const reset = new AuthStore({
    database,
    dataDir,
    stateKey: "auth",
    legacyImportStateKey: "auth_legacy_marker",
  });
  assert.equal((await reset.status(replacementToken)).configured, false);
  assert.equal((await reset.status(legacyToken)).authenticated, false);
});

test("migrates a database single-session state without invalidating its active token", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "birdbox-auth-state-v1-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);

  const database = new MemoryDatabase();
  const original = new AuthStore({ database, dataDir });
  const originalToken = await original.setup("migration-admin-password", "migration-admin-password");
  const stored = await database.readState("auth");
  const originalSession = stored.value.sessions[0];
  database.states.set("auth", {
    revision: stored.revision,
    value: {
      version: 1,
      configured: true,
      username: "admin",
      password: stored.value.password,
      session: {
        tokenHash: originalSession.tokenHash,
        createdAt: originalSession.createdAt,
        expiresAt: originalSession.expiresAt,
      },
    },
  });

  const migrated = new AuthStore({ database, dataDir });
  await migrated.initialize();
  assert.equal((await migrated.status(originalToken)).authenticated, true);
  const migratedState = await database.readState("auth");
  assert.equal(migratedState.value.version, 2);
  assert.equal(migratedState.value.sessions.length, 1);
  assert.match(migratedState.value.sessions[0].id, /^legacy_[a-f0-9]{24}$/);

  const secondToken = await migrated.login("migration-admin-password", {
    address: "192.0.2.10",
    userAgent: "Migration test client",
  });
  assert.ok(secondToken);
  assert.equal((await migrated.status(originalToken)).authenticated, true);
  assert.equal((await migrated.status(secondToken)).authenticated, true);
  const sessions = await migrated.listSessions(secondToken);
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((session) => session.current).address, "192.0.2.10");
});
