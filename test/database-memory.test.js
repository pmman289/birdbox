import test from "node:test";
import assert from "node:assert/strict";

import { MemoryDatabase } from "../src/database.js";

test("MemoryDatabase preserves MySQL-style revision conflicts across queued writes", async () => {
  const database = new MemoryDatabase();
  await database.createState("state", { count: 0 });
  let releaseMutation;
  let mutationStarted;
  const started = new Promise((resolve) => { mutationStarted = resolve; });
  const release = new Promise((resolve) => { releaseMutation = resolve; });
  const mutation = database.mutateState("state", { count: 0 }, async (value) => {
    mutationStarted();
    await release;
    return { value: { count: value.count + 1 } };
  });
  await started;
  const replacement = database.replaceState("state", 1, { count: 99 });
  releaseMutation();
  await mutation;
  await assert.rejects(
    () => replacement,
    (error) => error.code === "STATE_CONFLICT" && error.status === 409,
  );
  assert.deepEqual((await database.readState("state")).value, { count: 1 });
});

test("MemoryDatabase rejects a second deployment lock instead of queuing it", async () => {
  const database = new MemoryDatabase();
  let releaseLock;
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  const hold = new Promise((resolve) => { releaseLock = resolve; });
  const first = database.withLock("deployment", async () => {
    firstEntered();
    await hold;
  });
  await entered;
  await assert.rejects(
    () => database.withLock("deployment", async () => undefined),
    (error) => error.code === "DEPLOYMENT_LOCKED" && error.status === 409,
  );
  releaseLock();
  await first;
});
