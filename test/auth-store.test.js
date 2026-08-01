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
