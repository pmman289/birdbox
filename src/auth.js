import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const AUTH_COOKIE_NAME = "birdbox_session";
export const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const LEGACY_IMPORT_MARKER = Object.freeze({ version: 1, completed: false });
const AUTH_STATE_VERSION = 2;
const SESSION_ID_BYTES = 16;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_STORED_SESSIONS = 128;
const MAX_SESSION_ADDRESS_LENGTH = 128;
const MAX_SESSION_USER_AGENT_LENGTH = 512;

function authError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizePassword(value, confirmation) {
  const password = typeof value === "string" ? value : "";
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw authError(400, "PASSWORD_INVALID", `密码长度应为 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
  if (password !== confirmation) throw authError(400, "PASSWORD_MISMATCH", "两次输入的密码不一致");
  return password;
}

function tokenHash(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

function safeHexEqual(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left), "hex");
    const rightBuffer = Buffer.from(String(right), "hex");
    return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  } catch {
    return false;
  }
}

function isBase64(value, expectedLength) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").length === expectedLength;
}

function isPowerOfTwo(value) {
  return Number.isSafeInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function normalizeScryptOptions(value = SCRYPT_OPTIONS) {
  const options = value ?? SCRYPT_OPTIONS;
  const N = Number(options.N);
  const r = Number(options.r);
  const p = Number(options.p);
  const maxmem = Number(options.maxmem);
  if (!isPowerOfTwo(N) || N < 16384 || N > 1048576 || !Number.isSafeInteger(r) || r < 1 || r > 32
    || !Number.isSafeInteger(p) || p < 1 || p > 16 || !Number.isSafeInteger(maxmem) || maxmem < 32 * 1024 * 1024 || maxmem > 512 * 1024 * 1024) {
    throw new Error("Birdbox 认证状态中的 scrypt 参数无效");
  }
  return { N, r, p, maxmem };
}

function passwordRecordIsCurrent(record) {
  const options = normalizeScryptOptions(record.params ?? SCRYPT_OPTIONS);
  return Object.entries(SCRYPT_OPTIONS).every(([key, value]) => options[key] === value);
}

async function makePasswordRecord(password) {
  const options = normalizeScryptOptions();
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH, options);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    params: options,
  };
}

async function verifyPassword(password, record) {
  if (!record || record.algorithm !== "scrypt") return false;
  try {
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = await scrypt(String(password ?? ""), salt, expected.length, normalizeScryptOptions(record.params ?? SCRYPT_OPTIONS));
    return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function normalizeSessionText(value, maximumLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function normalizeSessionContext(value = {}) {
  return {
    address: normalizeSessionText(value.address, MAX_SESSION_ADDRESS_LENGTH),
    userAgent: normalizeSessionText(value.userAgent, MAX_SESSION_USER_AGENT_LENGTH),
  };
}

function createSession(ttlMs, context) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  return {
    token,
    record: {
      id: randomBytes(SESSION_ID_BYTES).toString("base64url"),
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt: now + ttlMs,
      ...normalizeSessionContext(context),
    },
  };
}

function normalizeStoredSession(value, { legacy = false } = {}) {
  const valid = value
    && typeof value.tokenHash === "string"
    && /^[a-f0-9]{64}$/i.test(value.tokenHash)
    && Number.isFinite(value.createdAt)
    && Number.isFinite(value.expiresAt)
    && value.createdAt <= value.expiresAt
    && (legacy || (typeof value.id === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value.id)))
    && (legacy || (typeof value.address === "string" && value.address.length <= MAX_SESSION_ADDRESS_LENGTH))
    && (legacy || (typeof value.userAgent === "string" && value.userAgent.length <= MAX_SESSION_USER_AGENT_LENGTH));
  if (!valid) throw new Error("Birdbox 认证状态中的会话格式无效");
  return {
    id: legacy ? `legacy_${value.tokenHash.slice(0, 24)}` : value.id,
    tokenHash: value.tokenHash.toLowerCase(),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ...normalizeSessionContext(legacy ? {} : value),
  };
}

function validateStoredState(value) {
  if ((value?.version === 1 || value?.version === AUTH_STATE_VERSION) && value.configured === false) {
    return { version: AUTH_STATE_VERSION, configured: false, username: "admin", password: null, sessions: [] };
  }
  const commonValid = value
    && (value.version === 1 || value.version === AUTH_STATE_VERSION)
    && value.username === "admin"
    && value.password?.algorithm === "scrypt"
    && isBase64(value.password.salt, 16)
    && isBase64(value.password.hash, SCRYPT_KEY_LENGTH)
    && (() => {
      try {
        normalizeScryptOptions(value.password.params ?? SCRYPT_OPTIONS);
        return true;
      } catch {
        return false;
      }
    })();
  if (!commonValid) throw new Error("Birdbox 认证状态格式无效，请从备份恢复");
  let sessions;
  if (value.version === 1) {
    sessions = value.session === null ? [] : [normalizeStoredSession(value.session, { legacy: true })];
  } else {
    if (!Array.isArray(value.sessions) || value.sessions.length > MAX_STORED_SESSIONS) {
      throw new Error("Birdbox 认证状态中的会话集合无效");
    }
    sessions = value.sessions.map((session) => normalizeStoredSession(session));
  }
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length
    || new Set(sessions.map((session) => session.tokenHash)).size !== sessions.length) {
    throw new Error("Birdbox 认证状态中存在重复会话");
  }
  return {
    version: AUTH_STATE_VERSION,
    configured: true,
    username: "admin",
    password: value.password,
    sessions,
  };
}

function activeSessions(state, now = Date.now()) {
  return state.sessions.filter((session) => session.expiresAt > now);
}

function sessionForToken(state, token, now = Date.now()) {
  if (!state?.configured || !token) return null;
  const hash = tokenHash(token);
  return activeSessions(state, now).find((session) => safeHexEqual(hash, session.tokenHash)) ?? null;
}

export class AuthStore {
  constructor({ database, dataDir, sessionTtlMs = AUTH_SESSION_TTL_MS, stateKey = "auth", legacyImportStateKey = null }) {
    this.database = database;
    this.authPath = path.join(dataDir, "auth.json");
    this.sessionTtlMs = sessionTtlMs;
    this.stateKey = stateKey;
    this.legacyImportStateKey = legacyImportStateKey ?? `migration_${createHash("sha256").update(stateKey).digest("hex").slice(0, 48)}`;
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.#initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async #initialize() {
    await this.database.initialize();
    const emptyState = this.#emptyState();
    await this.database.createState(this.stateKey, emptyState);
    await this.database.createState(this.legacyImportStateKey, LEGACY_IMPORT_MARKER);
    const currentRecord = await this.database.readState(this.stateKey);
    const current = validateStoredState(currentRecord.value);
    const marker = await this.database.readState(this.legacyImportStateKey);
    const importCompleted = marker?.value?.version === 1 && marker.value.completed === true;
    if (!marker || marker.value?.version !== 1 || typeof marker.value.completed !== "boolean") {
      throw new Error("Birdbox 认证迁移状态格式无效，请从备份恢复");
    }
    if (!current.configured && !importCompleted) {
      let legacy = null;
      try {
        legacy = validateStoredState(JSON.parse(await fs.readFile(this.authPath, "utf8")));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (legacy) {
        // A legacy session token must never survive migration into the database.
        await this.database.mutateState(this.stateKey, emptyState, async (latestInput) => {
          const latest = validateStoredState(latestInput);
          return latest.configured ? {} : { value: { ...legacy, sessions: [] } };
        });
      }
    }
    if (!importCompleted) {
      await this.database.mutateState(this.legacyImportStateKey, LEGACY_IMPORT_MARKER, async () => ({
        value: { version: 1, completed: true },
      }));
    }
    await this.database.mutateState(this.stateKey, emptyState, async (latestInput) => {
      const normalized = validateStoredState(latestInput);
      return isDeepStrictEqual(normalized, latestInput) ? {} : { value: normalized };
    });
  }

  async isConfigured() {
    return (await this.#read()).configured;
  }

  async isAuthenticated(token) {
    return this.#isAuthenticated(await this.#read(), token);
  }

  #isAuthenticated(state, token) {
    return Boolean(sessionForToken(state, token));
  }

  async status(token) {
    const state = await this.#read();
    return {
      configured: state.configured,
      authenticated: this.#isAuthenticated(state, token),
      username: "admin",
      singleSession: false,
    };
  }

  async setup(passwordInput, confirmation, context = {}) {
    await this.initialize();
    const observed = await this.#read();
    if (observed.configured) throw authError(409, "AUTH_ALREADY_CONFIGURED", "管理密码已经设置");
    const password = normalizePassword(passwordInput, confirmation);
    const passwordRecord = await makePasswordRecord(password);
    const session = createSession(this.sessionTtlMs, context);
    const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
      const current = validateStoredState(currentInput);
      if (current.configured) throw authError(409, "AUTH_ALREADY_CONFIGURED", "管理密码已经设置");
      const state = {
        version: AUTH_STATE_VERSION,
        configured: true,
        username: "admin",
        password: passwordRecord,
        sessions: [session.record],
      };
      return { value: state, result: session.token };
    });
    return operation.result;
  }

  async login(password, context = {}) {
    await this.initialize();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observed = await this.#read();
      if (!observed.configured) throw authError(409, "AUTH_SETUP_REQUIRED", "请先设置管理密码");
      if (!await verifyPassword(password, observed.password)) return null;
      const session = createSession(this.sessionTtlMs, context);
      const passwordRecord = passwordRecordIsCurrent(observed.password)
        ? observed.password
        : await makePasswordRecord(password);
      const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
        const current = validateStoredState(currentInput);
        if (!current.configured) throw authError(409, "AUTH_SETUP_REQUIRED", "请先设置管理密码");
        if (!isDeepStrictEqual(current.password, observed.password)) return { result: null };
        const sessions = activeSessions(current);
        if (sessions.length >= MAX_ACTIVE_SESSIONS) {
          throw authError(409, "AUTH_SESSION_LIMIT", "有效登录会话过多，请先在已登录设备中注销旧会话");
        }
        return { value: { ...current, password: passwordRecord, sessions: [...sessions, session.record] }, result: session.token };
      });
      if (operation.result) return operation.result;
    }
    return null;
  }

  async changePassword(token, currentPassword, passwordInput, confirmation, context = {}) {
    await this.initialize();
    const observed = await this.#read();
    if (!this.#isAuthenticated(observed, token)) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
    if (!await verifyPassword(currentPassword, observed.password)) {
      throw authError(403, "CURRENT_PASSWORD_INVALID", "当前密码不正确");
    }
    const password = normalizePassword(passwordInput, confirmation);
    const passwordRecord = await makePasswordRecord(password);
    const session = createSession(this.sessionTtlMs, context);
    const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
      const current = validateStoredState(currentInput);
      if (!this.#isAuthenticated(current, token)) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
      if (!isDeepStrictEqual(current.password, observed.password)) {
        throw authError(409, "AUTH_STATE_CHANGED", "认证状态已变化，请重新登录后再试");
      }
      const state = {
        ...current,
        password: passwordRecord,
        sessions: [session.record],
      };
      return { value: state, result: session.token };
    });
    return operation.result;
  }

  async logout(token) {
    await this.initialize();
    const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
      const current = validateStoredState(currentInput);
      const session = sessionForToken(current, token);
      if (!session) return { result: false };
      return {
        value: { ...current, sessions: activeSessions(current).filter((item) => item.id !== session.id) },
        result: true,
      };
    });
    return operation.result;
  }

  async listSessions(token) {
    const state = await this.#read();
    const current = sessionForToken(state, token);
    if (!current) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
    return activeSessions(state)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((session) => ({
        id: session.id,
        address: session.address,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        current: session.id === current.id,
      }));
  }

  async revokeSession(token, sessionId) {
    await this.initialize();
    const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
      const current = validateStoredState(currentInput);
      const caller = sessionForToken(current, token);
      if (!caller) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
      const sessions = activeSessions(current);
      const target = sessions.find((session) => session.id === sessionId);
      if (!target) throw authError(404, "AUTH_SESSION_NOT_FOUND", "登录会话不存在或已经失效");
      return {
        value: { ...current, sessions: sessions.filter((session) => session.id !== target.id) },
        result: { current: target.id === caller.id },
      };
    });
    return operation.result;
  }

  async revokeOtherSessions(token) {
    await this.initialize();
    const operation = await this.database.mutateState(this.stateKey, this.#emptyState(), async (currentInput) => {
      const current = validateStoredState(currentInput);
      const caller = sessionForToken(current, token);
      if (!caller) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
      const sessions = activeSessions(current);
      return {
        value: { ...current, sessions: [caller] },
        result: sessions.length - 1,
      };
    });
    return operation.result;
  }

  async #read() {
    await this.initialize();
    const record = await this.database.readState(this.stateKey);
    return validateStoredState(record.value);
  }

  #emptyState() {
    return { version: AUTH_STATE_VERSION, configured: false, username: "admin", password: null, sessions: [] };
  }
}
