import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { AuthStore } from "../auth.js";
import { AUTH_COOKIE_NAME, AUTH_SESSION_TTL_MS } from "../auth.js";
import type { BirdboxError } from "../database.js";

interface AuthRoutesOptions {
  authStore: AuthStore;
  secureCookieSetting: boolean | null;
}

interface LoginAttempt {
  id: number;
  timestamp: number;
}

interface LoginReservation {
  key: string;
  id: number;
}

type JsonObject = Record<string, unknown>;

declare module "fastify" {
  interface FastifyRequest {
    loginReservation: LoginReservation | null;
  }
}

const LOGIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const MAX_LOGIN_FAILURE_KEYS = 10_000;

function routeError(status: number, code: string, message: string): BirdboxError {
  const error = new Error(message) as BirdboxError;
  error.status = status;
  error.code = code;
  return error;
}

function jsonBody(request: FastifyRequest): JsonObject {
  const value = request.body === undefined ? {} : request.body;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError(400, "INVALID_JSON_BODY", "JSON 请求体必须是合法对象");
  }
  return value as JsonObject;
}

function jsonReply(reply: FastifyReply, status: number, payload: unknown, headers: Record<string, string> = {}): FastifyReply {
  return reply.code(status).headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  }).send(payload);
}

export function requestSessionToken(request: FastifyRequest): string {
  const cookie = String(request.headers.cookie ?? "");
  for (const part of cookie.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== AUTH_COOKIE_NAME) continue;
    try {
      return decodeURIComponent(valueParts.join("="));
    } catch {
      return "";
    }
  }
  return "";
}

function secureCookieEnabled(request: FastifyRequest, setting: boolean | null): boolean {
  if (setting !== null) return setting;
  return Boolean((request.socket as { encrypted?: boolean }).encrypted)
    || String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
}

export function sessionCookie(
  request: FastifyRequest,
  token: string,
  secureCookieSetting: boolean | null,
  maxAgeSeconds = Math.floor(AUTH_SESSION_TTL_MS / 1000),
): string {
  const secure = secureCookieEnabled(request, secureCookieSetting) ? "; Secure" : "";
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function loginAttemptKey(request: FastifyRequest): string {
  return request.socket.remoteAddress ?? "unknown";
}

function authSessionContext(request: FastifyRequest): { address: string; userAgent: string | string[] } {
  return {
    address: request.socket.remoteAddress ?? "",
    userAgent: request.headers["user-agent"] ?? "",
  };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const loginFailures = new Map<string, LoginAttempt[]>();
  let loginAttemptSequence = 0;
  let lastLoginFailurePruneAt = 0;

  const activeLoginFailures = (request: FastifyRequest): LoginAttempt[] => {
    const key = loginAttemptKey(request);
    const now = Date.now();
    const recent = (loginFailures.get(key) ?? []).filter((attempt) => now - attempt.timestamp < LOGIN_ATTEMPT_WINDOW_MS);
    if (recent.length) loginFailures.set(key, recent);
    else loginFailures.delete(key);
    return recent;
  };

  const pruneLoginFailureKeys = (): void => {
    const now = Date.now();
    if (loginFailures.size < MAX_LOGIN_FAILURE_KEYS && now - lastLoginFailurePruneAt < 60_000) return;
    for (const [key, attempts] of loginFailures) {
      const recent = attempts.filter((attempt) => now - attempt.timestamp < LOGIN_ATTEMPT_WINDOW_MS);
      if (recent.length) loginFailures.set(key, recent);
      else loginFailures.delete(key);
    }
    lastLoginFailurePruneAt = now;
  };

  const reserveLoginAttempt = (request: FastifyRequest): LoginReservation => {
    pruneLoginFailureKeys();
    const key = loginAttemptKey(request);
    const recent = activeLoginFailures(request);
    if (recent.length >= LOGIN_ATTEMPT_LIMIT || (!loginFailures.has(key) && loginFailures.size >= MAX_LOGIN_FAILURE_KEYS)) {
      throw routeError(429, "AUTH_RATE_LIMITED", "登录尝试过多，请稍后再试");
    }
    const reservation = { id: ++loginAttemptSequence, timestamp: Date.now() };
    loginFailures.set(key, [...recent, reservation]);
    return { key, id: reservation.id };
  };

  const cancelLoginAttempt = (reservation: LoginReservation): void => {
    const remaining = (loginFailures.get(reservation.key) ?? []).filter((attempt) => attempt.id !== reservation.id);
    if (remaining.length) loginFailures.set(reservation.key, remaining);
    else loginFailures.delete(reservation.key);
  };

  const clearLoginFailures = (request: FastifyRequest): void => {
    loginFailures.delete(loginAttemptKey(request));
  };

  const loginOnRequest = async (request: FastifyRequest): Promise<void> => {
    request.loginReservation = reserveLoginAttempt(request);
  };

  const loginOnError = async (request: FastifyRequest): Promise<void> => {
    if (!request.loginReservation) return;
    cancelLoginAttempt(request.loginReservation);
    request.loginReservation = null;
  };

  app.get("/api/auth/status", async (request, reply) => {
    return jsonReply(reply, 200, await options.authStore.status(requestSessionToken(request)));
  });

  app.post("/api/auth/setup", async (request, reply) => {
    const body = jsonBody(request);
    const token = await options.authStore.setup(body.password, body.confirmation, authSessionContext(request));
    return jsonReply(reply, 201, { ok: true, ...await options.authStore.status(token) }, {
      "set-cookie": sessionCookie(request, token, options.secureCookieSetting),
    });
  });

  app.post("/api/auth/login", { onRequest: loginOnRequest, onError: loginOnError }, async (request, reply) => {
    const reservation = request.loginReservation ?? reserveLoginAttempt(request);
    let token: string | null;
    try {
      token = await options.authStore.login(jsonBody(request).password, authSessionContext(request));
    } catch (error) {
      cancelLoginAttempt(reservation);
      request.loginReservation = null;
      throw error;
    }
    if (!token) {
      request.loginReservation = null;
      throw routeError(401, "AUTH_INVALID", "密码不正确");
    }
    clearLoginFailures(request);
    request.loginReservation = null;
    return jsonReply(reply, 200, { ok: true, ...await options.authStore.status(token) }, {
      "set-cookie": sessionCookie(request, token, options.secureCookieSetting),
    });
  });

  app.post("/api/auth/password", async (request, reply) => {
    const body = jsonBody(request);
    const token = requestSessionToken(request);
    const nextToken = await options.authStore.changePassword(
      token,
      body.currentPassword,
      body.password,
      body.confirmation,
      authSessionContext(request),
    );
    return jsonReply(reply, 200, { ok: true, ...await options.authStore.status(nextToken) }, {
      "set-cookie": sessionCookie(request, nextToken, options.secureCookieSetting),
    });
  });

  app.get("/api/auth/sessions", async (request, reply) => {
    return jsonReply(reply, 200, { sessions: await options.authStore.listSessions(requestSessionToken(request)) });
  });

  app.delete("/api/auth/sessions", async (request, reply) => {
    const revoked = await options.authStore.revokeOtherSessions(requestSessionToken(request));
    return jsonReply(reply, 200, { ok: true, revoked });
  });

  app.delete<{ Params: { sessionId: string } }>("/api/auth/sessions/:sessionId", async (request, reply) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(request.params.sessionId)) {
      throw routeError(404, "NOT_FOUND", "接口不存在");
    }
    const result = await options.authStore.revokeSession(requestSessionToken(request), request.params.sessionId);
    const headers: Record<string, string> = result.current
      ? { "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0) }
      : {};
    return jsonReply(reply, 200, { ok: true, current: result.current }, headers);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await options.authStore.logout(requestSessionToken(request));
    return jsonReply(reply, 200, { ok: true }, {
      "set-cookie": sessionCookie(request, "", options.secureCookieSetting, 0),
    });
  });
};
