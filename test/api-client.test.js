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

test("gives Direct and Kernel deployments the deployment deadline and reconciles lost responses", async (context) => {
  const browser = installBrowserFakes(async () => { throw new TypeError("Failed to fetch"); });
  context.after(() => browser.restore());
  const deadlines = [];
  globalThis.window.setTimeout = (callback, delay) => {
    deadlines.push(delay);
    return setTimeout(callback, delay);
  };
  for (const path of ["/api/directs/direct_one", "/api/kernels/kernel_one?refresh=true"]) {
    await assert.rejects(api(path, { method: "PUT", body: "{}" }), (error) => error instanceof ApiError && error.unknownOutcome);
  }
  assert.deepEqual(deadlines, [1_810_000, 1_810_000]);
  assert.equal(browser.events.filter((event) => event.type === "birdbox:unknown-mutation-outcome").length, 2);
});

test("preserves Headers overrides and handles a JSON null error without reporting a network failure", async (context) => {
  let receivedHeaders;
  const browser = installBrowserFakes(async (_path, options) => {
    receivedHeaders = options.headers;
    return new Response("null", { status: 502 });
  });
  context.after(() => browser.restore());
  await assert.rejects(api("/api/kernels", {
    method: "POST", headers: new Headers({ "content-type": "application/custom+json", "x-test": "value" }), body: "{}",
  }), (error) => error instanceof ApiError && error.status === 502 && !error.unknownOutcome && error.code === null);
  assert.equal(receivedHeaders.get("content-type"), "application/custom+json");
  assert.equal(receivedHeaders.get("x-test"), "value");
});

test("gives Agent promotion the deployment deadline while layout writes use the ordinary deadline", async (context) => {
  const browser = installBrowserFakes(async () => { throw new TypeError("Failed to fetch"); });
  context.after(() => browser.restore());
  const deadlines = [];
  globalThis.window.setTimeout = (callback, delay) => {
    deadlines.push(delay);
    return setTimeout(callback, delay);
  };
  await assert.rejects(api("/api/nodes/node_one/promote-agent", { method: "POST" }), (error) => error.unknownOutcome);
  await assert.rejects(api("/api/ibgp-domains/core/layout", { method: "PATCH", body: "{}" }), (error) => !error.unknownOutcome);
  assert.deepEqual(deadlines, [1_810_000, 60_000]);
  assert.equal(browser.events.filter((event) => event.type === "birdbox:unknown-mutation-outcome").length, 1);
});

test("reconciles a deployment whose successful or gateway response is not JSON", async (context) => {
  let status = 200;
  const browser = installBrowserFakes(async () => new Response("<html>Proxy response</html>", { status }));
  context.after(() => browser.restore());
  for (status of [200, 502]) {
    await assert.rejects(api("/api/sessions/apply", { method: "POST", body: "{}" }),
      (error) => error instanceof ApiError && error.status === status && error.code === "INVALID_RESPONSE" && error.unknownOutcome);
  }
  await assert.rejects(api("/api/dashboard"), (error) => error instanceof ApiError && !error.unknownOutcome);
  assert.equal(browser.events.filter((event) => event.type === "birdbox:unknown-mutation-outcome").length, 2);
});

test("still dispatches authentication expiry when a proxy returns non-JSON 401", async (context) => {
  const browser = installBrowserFakes(async () => new Response("unauthorized", { status: 401 }));
  context.after(() => browser.restore());
  await assert.rejects(api("/api/dashboard"), (error) => error instanceof ApiError && error.status === 401);
  assert.deepEqual(browser.events.map((event) => event.type), ["birdbox:auth-required"]);
});
