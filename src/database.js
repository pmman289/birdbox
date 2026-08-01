import mysql from "mysql2/promise";

const DEFAULT_CONNECT_RETRIES = 30;
const DEFAULT_CONNECT_RETRY_MS = 1000;
const MIN_CONNECTION_LIMIT = 2;
const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "initial_state_store",
    tables: ["birdbox_state"],
    statements: [
      `
        CREATE TABLE IF NOT EXISTS birdbox_state (
          state_key VARCHAR(64) NOT NULL PRIMARY KEY,
          revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
          document JSON NOT NULL,
          created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `,
    ],
  },
];

const MYSQL_TABLE_CONTRACTS = {
  birdbox_schema_migrations: {
    engine: "innodb",
    collation: "utf8mb4_unicode_ci",
    columns: [
      { name: "version", type: "int unsigned", nullable: false, defaultValue: null, extra: "", characterSet: null, collation: null },
      { name: "name", type: "varchar(128)", nullable: false, defaultValue: null, extra: "", characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" },
      { name: "applied_at", type: "timestamp(3)", nullable: false, defaultValue: "current_timestamp(3)", extra: "", characterSet: null, collation: null },
    ],
    uniqueIndexes: [
      { name: "PRIMARY", type: "btree", columns: ["version"] },
    ],
  },
  birdbox_state: {
    engine: "innodb",
    collation: "utf8mb4_unicode_ci",
    columns: [
      { name: "state_key", type: "varchar(64)", nullable: false, defaultValue: null, extra: "", characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" },
      { name: "revision", type: "bigint unsigned", nullable: false, defaultValue: "1", extra: "", characterSet: null, collation: null },
      { name: "document", type: "json", nullable: false, defaultValue: null, extra: "", characterSet: null, collation: null },
      { name: "created_at", type: "timestamp(3)", nullable: false, defaultValue: "current_timestamp(3)", extra: "", characterSet: null, collation: null },
      { name: "updated_at", type: "timestamp(3)", nullable: false, defaultValue: "current_timestamp(3)", extra: "on update current_timestamp(3)", characterSet: null, collation: null },
    ],
    uniqueIndexes: [
      { name: "PRIMARY", type: "btree", columns: ["state_key"] },
    ],
  },
};

function databaseError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizedMetadataValue(value) {
  if (value === null) return null;
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedColumnExtra(value) {
  const normalized = normalizedMetadataValue(value);
  if (normalized === null) return null;
  return normalized.replace(/\bdefault_generated\b/g, "").trim().replace(/\s+/g, " ");
}

function invalidSchema(tableName, detail) {
  return databaseError(500, "DATABASE_SCHEMA_INVALID", `${tableName} 的数据库结构不兼容：${detail}`);
}

export function validateMySqlTableContract(tableName, metadata) {
  const contract = MYSQL_TABLE_CONTRACTS[tableName];
  if (!contract) throw new Error(`未知的 MySQL 表契约：${tableName}`);

  const tables = metadata?.tables ?? [];
  if (tables.length !== 1) throw invalidSchema(tableName, tables.length ? "表定义重复" : "表不存在");
  if (normalizedMetadataValue(tables[0].ENGINE) !== contract.engine) {
    throw invalidSchema(tableName, "存储引擎必须为 InnoDB");
  }
  if (normalizedMetadataValue(tables[0].TABLE_COLLATION) !== contract.collation) {
    throw invalidSchema(tableName, `表排序规则必须为 ${contract.collation}`);
  }

  const columns = [...(metadata?.columns ?? [])].sort(
    (left, right) => Number(left.ORDINAL_POSITION) - Number(right.ORDINAL_POSITION),
  );
  if (columns.length !== contract.columns.length) {
    throw invalidSchema(tableName, "列集合与当前程序不匹配");
  }
  for (let index = 0; index < contract.columns.length; index += 1) {
    const expected = contract.columns[index];
    const actual = columns[index];
    if (actual.COLUMN_NAME !== expected.name || Number(actual.ORDINAL_POSITION) !== index + 1) {
      throw invalidSchema(tableName, `第 ${index + 1} 列必须为 ${expected.name}`);
    }
    if (normalizedMetadataValue(actual.COLUMN_TYPE) !== expected.type) {
      throw invalidSchema(tableName, `${expected.name} 的类型必须为 ${expected.type}`);
    }
    if (String(actual.IS_NULLABLE).toUpperCase() !== (expected.nullable ? "YES" : "NO")) {
      throw invalidSchema(tableName, `${expected.name} 的 NULL 约束不兼容`);
    }
    if (normalizedMetadataValue(actual.COLUMN_DEFAULT) !== expected.defaultValue) {
      throw invalidSchema(tableName, `${expected.name} 的默认值不兼容`);
    }
    if (normalizedColumnExtra(actual.EXTRA) !== expected.extra) {
      throw invalidSchema(tableName, `${expected.name} 的自动更新或生成属性不兼容`);
    }
    if (normalizedMetadataValue(actual.CHARACTER_SET_NAME) !== expected.characterSet) {
      throw invalidSchema(tableName, `${expected.name} 的字符集不兼容`);
    }
    if (normalizedMetadataValue(actual.COLLATION_NAME) !== expected.collation) {
      throw invalidSchema(tableName, `${expected.name} 的排序规则不兼容`);
    }
  }

  const uniqueIndexes = new Map();
  for (const index of metadata?.indexes ?? []) {
    if (Number(index.NON_UNIQUE) !== 0) continue;
    const rows = uniqueIndexes.get(index.INDEX_NAME) ?? [];
    rows.push(index);
    uniqueIndexes.set(index.INDEX_NAME, rows);
  }
  if (uniqueIndexes.size !== contract.uniqueIndexes.length) {
    throw invalidSchema(tableName, "唯一索引集合与当前程序不匹配");
  }
  for (const expected of contract.uniqueIndexes) {
    const rows = uniqueIndexes.get(expected.name);
    if (!rows || rows.length !== expected.columns.length) {
      throw invalidSchema(tableName, `${expected.name} 索引定义不兼容`);
    }
    rows.sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX));
    for (let index = 0; index < rows.length; index += 1) {
      const actual = rows[index];
      if (
        Number(actual.SEQ_IN_INDEX) !== index + 1
        || actual.COLUMN_NAME !== expected.columns[index]
        || actual.SUB_PART !== null
        || normalizedMetadataValue(actual.INDEX_TYPE) !== expected.type
      ) {
        throw invalidSchema(tableName, `${expected.name} 索引列或顺序不兼容`);
      }
    }
  }
}

function positiveInteger(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function parseDocument(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return structuredClone(value);
}

function mysqlConfiguration(env) {
  if (env.BIRDBOX_DATABASE_URL) {
    const url = new URL(env.BIRDBOX_DATABASE_URL);
    if (url.protocol !== "mysql:") throw new Error("BIRDBOX_DATABASE_URL 必须使用 mysql://");
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database) throw new Error("BIRDBOX_DATABASE_URL 必须包含主机和数据库名");
    return {
      host: url.hostname,
      port: positiveInteger(url.port || 3306, "MySQL 端口", { maximum: 65535 }),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
    };
  }
  return {
    host: env.BIRDBOX_DB_HOST ?? "127.0.0.1",
    port: positiveInteger(env.BIRDBOX_DB_PORT ?? 3306, "MySQL 端口", { maximum: 65535 }),
    user: env.BIRDBOX_DB_USER ?? "birdbox",
    password: env.BIRDBOX_DB_PASSWORD ?? "",
    database: env.BIRDBOX_DB_NAME ?? "birdbox",
  };
}

export class MySqlDatabase {
  constructor(configuration, options = {}) {
    this.connectRetries = positiveInteger(options.connectRetries ?? DEFAULT_CONNECT_RETRIES, "MySQL 连接重试次数", { maximum: 300 });
    this.connectRetryMs = positiveInteger(options.connectRetryMs ?? DEFAULT_CONNECT_RETRY_MS, "MySQL 连接重试间隔", { minimum: 0, maximum: 60000 });
    // Deployment locks reserve one connection while state reads and writes use
    // another one, so a one-connection pool can never make forward progress.
    this.connectionLimit = Math.max(
      MIN_CONNECTION_LIMIT,
      positiveInteger(options.connectionLimit ?? 10, "MySQL 连接池大小", { maximum: 100 }),
    );
    this.initialization = null;
    this.pool = mysql.createPool({
      ...configuration,
      waitForConnections: true,
      connectionLimit: this.connectionLimit,
      queueLimit: 0,
      charset: "utf8mb4",
      timezone: "Z",
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      ssl: options.ssl ? {} : undefined,
    });
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
    await this.#waitForConnection();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS birdbox_schema_migrations (
        version INT UNSIGNED NOT NULL PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await this.#verifyTable("birdbox_schema_migrations");
    await this.withLock("schema-migrations", () => this.#runMigrations(), { timeoutMs: 30000 });
  }

  async #runMigrations() {
    const [appliedRows] = await this.pool.query("SELECT version, name FROM birdbox_schema_migrations ORDER BY version");
    const migrationsByVersion = new Map(SCHEMA_MIGRATIONS.map((migration) => [migration.version, migration]));
    const applied = new Map();
    for (const row of appliedRows) {
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw invalidSchema("birdbox_schema_migrations", "包含无效的迁移版本");
      }
      if (version > CURRENT_SCHEMA_VERSION) {
        throw databaseError(409, "DATABASE_SCHEMA_TOO_NEW", "数据库由更新版本的 Birdbox 初始化，当前版本拒绝继续运行");
      }
      const expected = migrationsByVersion.get(version);
      if (!expected || row.name !== expected.name) {
        throw invalidSchema("birdbox_schema_migrations", `迁移 ${version} 与当前程序不匹配`);
      }
      applied.set(version, row.name);
    }
    for (const migration of SCHEMA_MIGRATIONS) {
      const existing = applied.get(migration.version);
      if (existing) continue;
      for (const statement of migration.statements) await this.pool.query(statement);
      for (const tableName of migration.tables) await this.#verifyTable(tableName);
      await this.pool.execute(
        "INSERT INTO birdbox_schema_migrations (version, name) VALUES (?, ?)",
        [migration.version, migration.name],
      );
    }
    for (const migration of SCHEMA_MIGRATIONS) {
      for (const tableName of migration.tables) await this.#verifyTable(tableName);
    }
  }

  async #verifyTable(tableName) {
    const [tables] = await this.pool.execute(
      `
        SELECT ENGINE, TABLE_COLLATION
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      `,
      [tableName],
    );
    const [columns] = await this.pool.execute(
      `
        SELECT
          COLUMN_NAME,
          COLUMN_TYPE,
          IS_NULLABLE,
          COLUMN_DEFAULT,
          EXTRA,
          CHARACTER_SET_NAME,
          COLLATION_NAME,
          ORDINAL_POSITION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `,
      [tableName],
    );
    const [indexes] = await this.pool.execute(
      `
        SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, INDEX_TYPE
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
      `,
      [tableName],
    );
    validateMySqlTableContract(tableName, { tables, columns, indexes });
  }

  async ping() {
    await this.pool.query("SELECT 1");
    return true;
  }

  async close() {
    await this.pool.end();
  }

  async withLock(name, operation, options = {}) {
    const connection = await this.pool.getConnection();
    const lockName = `birdbox:${String(name)}`.slice(0, 64);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 0, "数据库锁超时", { minimum: 0, maximum: 60000 });
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    let acquired = false;
    try {
      const [rows] = await connection.execute("SELECT GET_LOCK(?, ?) AS acquired", [lockName, timeoutSeconds]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw databaseError(409, "DEPLOYMENT_LOCKED", "另一个 Birdbox 部署正在进行");
      return await operation();
    } finally {
      if (acquired) {
        try {
          await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
        } catch {
          // The connection will release the advisory lock if it was already lost.
        }
      }
      connection.release();
    }
  }

  async readState(key) {
    const [rows] = await this.pool.execute(
      "SELECT revision, document FROM birdbox_state WHERE state_key = ?",
      [key],
    );
    if (!rows.length) return null;
    return { revision: Number(rows[0].revision), value: parseDocument(rows[0].document) };
  }

  async createState(key, initialValue) {
    await this.pool.execute(
      "INSERT IGNORE INTO birdbox_state (state_key, revision, document) VALUES (?, 1, ?)",
      [key, JSON.stringify(initialValue)],
    );
    return this.readState(key);
  }

  async mutateState(key, initialValue, mutator) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "INSERT IGNORE INTO birdbox_state (state_key, revision, document) VALUES (?, 1, ?)",
        [key, JSON.stringify(initialValue)],
      );
      const [rows] = await connection.execute(
        "SELECT revision, document FROM birdbox_state WHERE state_key = ? FOR UPDATE",
        [key],
      );
      const revision = Number(rows[0].revision);
      const current = parseDocument(rows[0].document);
      const outcome = await mutator(structuredClone(current));
      const changed = outcome && Object.hasOwn(outcome, "value");
      const value = changed ? outcome.value : current;
      if (changed) {
        await connection.execute(
          "UPDATE birdbox_state SET revision = revision + 1, document = ? WHERE state_key = ?",
          [JSON.stringify(value), key],
        );
      }
      await connection.commit();
      return { value, result: outcome?.result, revision: revision + Number(changed) };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async replaceState(key, expectedRevision, value) {
    const [result] = await this.pool.execute(
      "UPDATE birdbox_state SET revision = revision + 1, document = ? WHERE state_key = ? AND revision = ?",
      [JSON.stringify(value), key, expectedRevision],
    );
    if (result.affectedRows !== 1) {
      throw databaseError(409, "STATE_CONFLICT", "数据已被其他操作更新，请刷新后重试");
    }
    return { value, revision: expectedRevision + 1 };
  }

  async #waitForConnection() {
    let lastError;
    for (let attempt = 1; attempt <= this.connectRetries; attempt += 1) {
      try {
        const connection = await this.pool.getConnection();
        connection.release();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.connectRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.connectRetryMs));
        }
      }
    }
    throw new Error(`无法连接 MySQL：${lastError?.message ?? "连接失败"}`);
  }
}

export class MemoryDatabase {
  constructor() {
    this.states = new Map();
    this.stateQueues = new Map();
    this.locks = new Set();
  }

  async initialize() {}
  async ping() { return true; }
  async close() {}

  async withLock(name, operation) {
    if (this.locks.has(name)) throw databaseError(409, "DEPLOYMENT_LOCKED", "另一个 Birdbox 部署正在进行");
    this.locks.add(name);
    try {
      return await operation();
    } finally {
      this.locks.delete(name);
    }
  }

  async readState(key) {
    const state = this.states.get(key);
    return state ? { revision: state.revision, value: structuredClone(state.value) } : null;
  }

  async createState(key, initialValue) {
    return this.#queueState(key, async () => {
      if (!this.states.has(key)) this.states.set(key, { revision: 1, value: structuredClone(initialValue) });
      return this.readState(key);
    });
  }

  async mutateState(key, initialValue, mutator) {
    return this.#queueState(key, async () => {
      if (!this.states.has(key)) this.states.set(key, { revision: 1, value: structuredClone(initialValue) });
      const state = this.states.get(key);
      const outcome = await mutator(structuredClone(state.value));
      if (outcome && Object.hasOwn(outcome, "value")) {
        state.value = structuredClone(outcome.value);
        state.revision += 1;
      }
      return { value: structuredClone(state.value), result: outcome?.result, revision: state.revision };
    });
  }

  async replaceState(key, expectedRevision, value) {
    return this.#queueState(key, async () => {
      const state = this.states.get(key);
      if (!state || state.revision !== expectedRevision) {
        throw databaseError(409, "STATE_CONFLICT", "数据已被其他操作更新，请刷新后重试");
      }
      state.value = structuredClone(value);
      state.revision += 1;
      return { value: structuredClone(value), revision: state.revision };
    });
  }

  #queueState(key, operation) {
    const previous = this.stateQueues.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    this.stateQueues.set(key, queued);
    queued.finally(() => {
      if (this.stateQueues.get(key) === queued) this.stateQueues.delete(key);
    }).catch(() => undefined);
    return queued;
  }
}

export function createDatabaseFromEnvironment(env = process.env) {
  if (env.NODE_ENV === "test" && env.BIRDBOX_DATABASE_URL === "memory:") return new MemoryDatabase();
  const configuration = mysqlConfiguration(env);
  return new MySqlDatabase(configuration, {
    connectionLimit: env.BIRDBOX_DB_POOL_SIZE ?? 10,
    connectRetries: env.BIRDBOX_DB_CONNECT_RETRIES ?? DEFAULT_CONNECT_RETRIES,
    connectRetryMs: env.BIRDBOX_DB_CONNECT_RETRY_MS ?? DEFAULT_CONNECT_RETRY_MS,
    ssl: env.BIRDBOX_DB_SSL === "true",
  });
}
