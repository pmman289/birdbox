import assert from "node:assert/strict";
import test from "node:test";

import { resolveApplicationRoot } from "../src/application-root.js";

test("resolves the same application root for source and compiled server modules", () => {
  assert.equal(resolveApplicationRoot(new URL("file:///app/src/server.ts")), "/app");
  assert.equal(resolveApplicationRoot(new URL("file:///app/dist/src/server.js")), "/app");
});
