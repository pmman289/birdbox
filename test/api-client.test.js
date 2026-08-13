import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, api } from "../apps/web/src/shared/api-client.ts";

class TestCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

function installBrowserFakes(fetchImplementation) {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const originalCustomEvent = globalThis.CustomEvent;
  const events = [];
  globalThis.window = {
    setTimeout,
    clearTimeout,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  globalThis.fetch = fetchImplementation;
  globalThis.CustomEvent = TestCustomEvent;
  return {
    events,
    restore() {
      globalThis.window = originalWindow;
      globalThis.fetch = originalFetch;
      globalThis.CustomEvent = originalCustomEvent;
    },
  };
}

test("pairs mutation wait events around a successful write", async (context) => {
  const browser = installBrowserFakes(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  context.after(() => browser.restore());

  assert.deepEqual(await api("/api/auth/logout", { method: "POST", body: "{}" }), { ok: true });
  assert.deepEqual(browser.events.map((event) => event.type), ["birdbox:mutation-start", "birdbox:mutation-end"]);
  assert.equal(browser.events[0].detail.presentation.title, "正在退出");
  assert.equal(browser.events[0].detail.requestId, browser.events[1].detail.requestId);
});

test("dispatches the shared authentication event for an expired session", async (context) => {
  const browser = installBrowserFakes(async () => new Response(JSON.stringify({
    error: "登录状态已失效",
    code: "AUTH_REQUIRED",
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }));
  context.after(() => browser.restore());

  await assert.rejects(
    api("/api/dashboard"),
    (error) => error instanceof ApiError && error.status === 401 && error.code === "AUTH_REQUIRED",
  );
  assert.deepEqual(browser.events.map((event) => event.type), ["birdbox:auth-required"]);
});

test("marks a timed out deployment write as an unknown outcome", async (context) => {
  const browser = installBrowserFakes((_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  context.after(() => browser.restore());

  await assert.rejects(
    api("/api/sessions/apply", { method: "POST", body: "{}", timeoutMs: 1 }),
    (error) => error instanceof ApiError && error.code === "REQUEST_TIMEOUT" && error.unknownOutcome,
  );
  assert.deepEqual(browser.events.map((event) => event.type), [
    "birdbox:mutation-start",
    "birdbox:unknown-mutation-outcome",
    "birdbox:mutation-end",
  ]);
});

test("marks a disconnected deployment response as an unknown outcome", async (context) => {
  const browser = installBrowserFakes(async () => {
    throw new TypeError("Failed to fetch");
  });
  context.after(() => browser.restore());

  await assert.rejects(
    api("/api/sessions/apply", { method: "POST", body: "{}" }),
    (error) => error instanceof ApiError
      && error.code === "NETWORK_ERROR"
      && error.unknownOutcome
      && /正在自动刷新/.test(error.message),
  );
  assert.deepEqual(browser.events.map((event) => event.type), [
    "birdbox:mutation-start",
    "birdbox:unknown-mutation-outcome",
    "birdbox:mutation-end",
  ]);
});
