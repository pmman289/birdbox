import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const AUTH_COOKIE_NAME = "birdbox_session";
export const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

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

async function makePasswordRecord(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

async function verifyPassword(password, record) {
  if (!record || record.algorithm !== "scrypt") return false;
  try {
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = await scrypt(String(password ?? ""), salt, expected.length, SCRYPT_OPTIONS);
    return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createSession(ttlMs) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  return {
    token,
    record: {
      tokenHash: tokenHash(token),
      createdAt: now,
      expiresAt: now + ttlMs,
    },
  };
}

function validateStoredState(value) {
  const valid = value
    && value.version === 1
    && value.username === "admin"
    && value.password?.algorithm === "scrypt"
    && typeof value.password.salt === "string"
    && typeof value.password.hash === "string"
    && (value.session === null || (
      typeof value.session?.tokenHash === "string"
      && Number.isFinite(value.session.createdAt)
      && Number.isFinite(value.session.expiresAt)
    ));
  if (!valid) throw new Error("Birdbox 认证文件格式无效，请恢复或移除 data/auth.json");
  return value;
}

export class AuthStore {
  constructor({ dataDir, sessionTtlMs = AUTH_SESSION_TTL_MS }) {
    this.dataDir = dataDir;
    this.authPath = path.join(dataDir, "auth.json");
    this.sessionTtlMs = sessionTtlMs;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      this.state = validateStoredState(JSON.parse(await fs.readFile(this.authPath, "utf8")));
      await fs.chmod(this.authPath, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = null;
    }
  }

  isConfigured() {
    return this.state !== null;
  }

  isAuthenticated(token) {
    const session = this.state?.session;
    return Boolean(
      session
      && session.expiresAt > Date.now()
      && safeHexEqual(tokenHash(token), session.tokenHash),
    );
  }

  status(token) {
    return {
      configured: this.isConfigured(),
      authenticated: this.isAuthenticated(token),
      username: "admin",
      singleSession: true,
    };
  }

  async setup(passwordInput, confirmation) {
    return this.#exclusive(async () => {
      if (this.isConfigured()) throw authError(409, "AUTH_ALREADY_CONFIGURED", "管理密码已经设置");
      const password = normalizePassword(passwordInput, confirmation);
      const session = createSession(this.sessionTtlMs);
      this.state = {
        version: 1,
        username: "admin",
        password: await makePasswordRecord(password),
        session: session.record,
      };
      await this.#save();
      return session.token;
    });
  }

  async login(password) {
    return this.#exclusive(async () => {
      if (!this.isConfigured()) throw authError(409, "AUTH_SETUP_REQUIRED", "请先设置管理密码");
      if (!await verifyPassword(password, this.state.password)) return null;
      const session = createSession(this.sessionTtlMs);
      this.state.session = session.record;
      await this.#save();
      return session.token;
    });
  }

  async changePassword(token, currentPassword, passwordInput, confirmation) {
    return this.#exclusive(async () => {
      if (!this.isAuthenticated(token)) throw authError(401, "AUTH_REQUIRED", "登录状态已失效");
      if (!await verifyPassword(currentPassword, this.state.password)) {
        throw authError(403, "CURRENT_PASSWORD_INVALID", "当前密码不正确");
      }
      const password = normalizePassword(passwordInput, confirmation);
      const session = createSession(this.sessionTtlMs);
      this.state.password = await makePasswordRecord(password);
      this.state.session = session.record;
      await this.#save();
      return session.token;
    });
  }

  async logout(token) {
    return this.#exclusive(async () => {
      if (!this.isAuthenticated(token)) return false;
      this.state.session = null;
      await this.#save();
      return true;
    });
  }

  async #exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async #save() {
    const temporary = `${this.authPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.authPath);
    await fs.chmod(this.authPath, 0o600);
  }
}
