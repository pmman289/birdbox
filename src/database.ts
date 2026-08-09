import mysql, {
  type Pool,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

export interface BirdboxError extends Error {
  status: number;
  code: string;
}

export interface StateRecord<Value> {
  revision: number;
  value: Value;
}

export interface StateMutationOutcome<Value, Result = unknown> {
  value?: Value;
  result?: Result;
}

export interface StateMutationResult<Value, Result = unknown> extends StateRecord<Value> {
  result: Result | undefined;
}

export interface StateDatabase {
  initialize(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  withLock<Result>(name: string, operation: () => Promise<Result> | Result, options?: LockOptions): Promise<Result>;
  readState<Value>(key: string): Promise<StateRecord<Value> | null>;
  createState<Value>(key: string, initialValue: Value): Promise<StateRecord<Value> | null>;
  mutateState<Value, Result>(
    key: string,
    initialValue: Value,
    mutator: (value: Value) => Promise<StateMutationOutcome<Value, Result>> | StateMutationOutcome<Value, Result>,
  ): Promise<StateMutationResult<Value, Result>>;
  replaceState<Value>(key: string, expectedRevision: number, value: Value): Promise<StateRecord<Value>>;
}

interface LockOptions {
  timeoutMs?: unknown;
}

interface DatabaseOptions {
  connectRetries?: unknown;
  connectRetryMs?: unknown;
  connectionLimit?: unknown;
  ssl?: boolean;
}

interface IntegerBounds {
  minimum?: number;
  maximum?: number;
}

interface TableMetadataRow extends RowDataPacket {
  ENGINE: unknown;
  TABLE_COLLATION: unknown;
}

interface ColumnMetadataRow extends RowDataPacket {
  COLUMN_NAME: string;
  COLUMN_TYPE: unknown;
  IS_NULLABLE: unknown;
  COLUMN_DEFAULT: unknown;
  EXTRA: unknown;
  CHARACTER_SET_NAME: unknown;
  COLLATION_NAME: unknown;
  ORDINAL_POSITION: unknown;
}

interface IndexMetadataRow extends RowDataPacket {
  INDEX_NAME: string;
  NON_UNIQUE: unknown;
  SEQ_IN_INDEX: unknown;
  COLUMN_NAME: string;
  SUB_PART: unknown;
  INDEX_TYPE: unknown;
}

export interface MySqlTableMetadata {
  tables?: TableMetadataRow[];
  columns?: ColumnMetadataRow[];
  indexes?: IndexMetadataRow[];
}

interface MigrationRow extends RowDataPacket {
  version: unknown;
  name: unknown;
}

interface StateRow extends RowDataPacket {
  revision: unknown;
  document: unknown;
}

interface LockRow extends RowDataPacket {
  acquired: unknown;
}

interface SchemaColumnContract {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  extra: string;
  characterSet: string | null;
  collation: string | null;
}

interface SchemaIndexContract {
  name: string;
  type: string;
  columns: string[];
}

interface SchemaTableContract {
  engine: string;
  collation: string;
  columns: SchemaColumnContract[];
  uniqueIndexes: SchemaIndexContract[];
}

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

const MYSQL_TABLE_CONTRACTS: Record<string, SchemaTableContract> = {
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

function databaseError(status: number, code: string, message: string): BirdboxError {
  const error = new Error(message) as BirdboxError;
  error.status = status;
  error.code = code;
  return error;
}

function normalizedMetadataValue(value: unknown): string | null {
  if (value === null) return null;
  return String(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedColumnExtra(value: unknown): string | null {
  const normalized = normalizedMetadataValue(value);
  if (normalized === null) return null;
  return normalized.replace(/\bdefault_generated\b/g, "").trim().replace(/\s+/g, " ");
}

function invalidSchema(tableName: string, detail: string): BirdboxError {
  return databaseError(500, "DATABASE_SCHEMA_INVALID", `${tableName} 的数据库结构不兼容：${detail}`);
}

export function validateMySqlTableContract(tableName: string, metadata: MySqlTableMetadata): void {
  const contract = MYSQL_TABLE_CONTRACTS[tableName];
  if (!contract) throw new Error(`未知的 MySQL 表契约：${tableName}`);

  const tables = metadata?.tables ?? [];
  if (tables.length !== 1) throw invalidSchema(tableName, tables.length ? "表定义重复" : "表不存在");
  const table = tables[0];
  if (!table) throw invalidSchema(tableName, "表不存在");
  if (normalizedMetadataValue(table.ENGINE) !== contract.engine) {
    throw invalidSchema(tableName, "存储引擎必须为 InnoDB");
  }
  if (normalizedMetadataValue(table.TABLE_COLLATION) !== contract.collation) {
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
    if (!expected || !actual) throw invalidSchema(tableName, "列集合与当前程序不匹配");
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

  const uniqueIndexes = new Map<string, IndexMetadataRow[]>();
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
      if (!actual) throw invalidSchema(tableName, `${expected.name} 索引列或顺序不兼容`);
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

function positiveInteger(
  value: unknown,
  label: string,
  { minimum = 1, maximum = Number.MAX_SAFE_INTEGER }: IntegerBounds = {},
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return number;
}

function parseDocument<Value>(value: unknown): Value | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return JSON.parse(value);
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString("utf8"));
  return structuredClone(value) as Value;
}

function mysqlConfiguration(env: NodeJS.ProcessEnv): PoolOptions {
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

export class MySqlDatabase implements StateDatabase {
  private readonly connectRetries: number;
  private readonly connectRetryMs: number;
  private readonly connectionLimit: number;
  private initialization: Promise<void> | null;
  private readonly pool: Pool;

  constructor(configuration: PoolOptions, options: DatabaseOptions = {}) {
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

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.#initialize().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async #initialize(): Promise<void> {
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

  async #runMigrations(): Promise<void> {
    const [appliedRows] = await this.pool.query<MigrationRow[]>("SELECT version, name FROM birdbox_schema_migrations ORDER BY version");
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
      if (!expected || String(row.name) !== expected.name) {
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

  async #verifyTable(tableName: string): Promise<void> {
    const [tables] = await this.pool.execute<TableMetadataRow[]>(
      `
        SELECT ENGINE, TABLE_COLLATION
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      `,
      [tableName],
    );
    const [columns] = await this.pool.execute<ColumnMetadataRow[]>(
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
    const [indexes] = await this.pool.execute<IndexMetadataRow[]>(
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

  async ping(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withLock<Result>(
    name: string,
    operation: () => Promise<Result> | Result,
    options: LockOptions = {},
  ): Promise<Result> {
    const connection = await this.pool.getConnection();
    const lockName = `birdbox:${String(name)}`.slice(0, 64);
    const timeoutMs = positiveInteger(options.timeoutMs ?? 0, "数据库锁超时", { minimum: 0, maximum: 60000 });
    const timeoutSeconds = Math.ceil(timeoutMs / 1000);
    let acquired = false;
    try {
      const [rows] = await connection.execute<LockRow[]>("SELECT GET_LOCK(?, ?) AS acquired", [lockName, timeoutSeconds]);
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

  async readState<Value>(key: string): Promise<StateRecord<Value> | null> {
    const [rows] = await this.pool.execute<StateRow[]>(
      "SELECT revision, document FROM birdbox_state WHERE state_key = ?",
      [key],
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (!row) return null;
    return { revision: Number(row.revision), value: parseDocument<Value>(row.document) as Value };
  }

  async createState<Value>(key: string, initialValue: Value): Promise<StateRecord<Value> | null> {
    await this.pool.execute(
      "INSERT IGNORE INTO birdbox_state (state_key, revision, document) VALUES (?, 1, ?)",
      [key, JSON.stringify(initialValue)],
    );
    return this.readState(key);
  }

  async mutateState<Value, Result>(
    key: string,
    initialValue: Value,
    mutator: (value: Value) => Promise<StateMutationOutcome<Value, Result>> | StateMutationOutcome<Value, Result>,
  ): Promise<StateMutationResult<Value, Result>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "INSERT IGNORE INTO birdbox_state (state_key, revision, document) VALUES (?, 1, ?)",
        [key, JSON.stringify(initialValue)],
      );
      const [rows] = await connection.execute<StateRow[]>(
        "SELECT revision, document FROM birdbox_state WHERE state_key = ? FOR UPDATE",
        [key],
      );
      const row = rows[0];
      if (!row) throw new Error(`状态 ${key} 初始化失败`);
      const revision = Number(row.revision);
      const current = parseDocument<Value>(row.document) as Value;
      const outcome = await mutator(structuredClone(current));
      const changed = outcome && Object.hasOwn(outcome, "value");
      const value: Value = changed ? outcome.value as Value : current;
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

  async replaceState<Value>(key: string, expectedRevision: number, value: Value): Promise<StateRecord<Value>> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE birdbox_state SET revision = revision + 1, document = ? WHERE state_key = ? AND revision = ?",
      [JSON.stringify(value), key, expectedRevision],
    );
    if (result.affectedRows !== 1) {
      throw databaseError(409, "STATE_CONFLICT", "数据已被其他操作更新，请刷新后重试");
    }
    return { value, revision: expectedRevision + 1 };
  }

  async #waitForConnection(): Promise<void> {
    let lastError: unknown;
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
    const message = lastError instanceof Error ? lastError.message : "连接失败";
    throw new Error(`无法连接 MySQL：${message}`);
  }
}

export class MemoryDatabase implements StateDatabase {
  private readonly states: Map<string, StateRecord<unknown>>;
  private readonly stateQueues: Map<string, Promise<unknown>>;
  private readonly locks: Set<string>;

  constructor() {
    this.states = new Map();
    this.stateQueues = new Map();
    this.locks = new Set();
  }

  async initialize(): Promise<void> {}
  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> {}

  async withLock<Result>(name: string, operation: () => Promise<Result> | Result): Promise<Result> {
    if (this.locks.has(name)) throw databaseError(409, "DEPLOYMENT_LOCKED", "另一个 Birdbox 部署正在进行");
    this.locks.add(name);
    try {
      return await operation();
    } finally {
      this.locks.delete(name);
    }
  }

  async readState<Value>(key: string): Promise<StateRecord<Value> | null> {
    const state = this.states.get(key);
    return state ? { revision: state.revision, value: structuredClone(state.value) as Value } : null;
  }

  async createState<Value>(key: string, initialValue: Value): Promise<StateRecord<Value> | null> {
    return this.#queueState(key, async () => {
      if (!this.states.has(key)) this.states.set(key, { revision: 1, value: structuredClone(initialValue) });
      return this.readState<Value>(key);
    });
  }

  async mutateState<Value, Result>(
    key: string,
    initialValue: Value,
    mutator: (value: Value) => Promise<StateMutationOutcome<Value, Result>> | StateMutationOutcome<Value, Result>,
  ): Promise<StateMutationResult<Value, Result>> {
    return this.#queueState(key, async () => {
      if (!this.states.has(key)) this.states.set(key, { revision: 1, value: structuredClone(initialValue) });
      const state = this.states.get(key);
      if (!state) throw new Error(`状态 ${key} 初始化失败`);
      const outcome = await mutator(structuredClone(state.value) as Value);
      if (outcome && Object.hasOwn(outcome, "value")) {
        state.value = structuredClone(outcome.value);
        state.revision += 1;
      }
      return { value: structuredClone(state.value) as Value, result: outcome?.result, revision: state.revision };
    });
  }

  async replaceState<Value>(key: string, expectedRevision: number, value: Value): Promise<StateRecord<Value>> {
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

  #queueState<Result>(key: string, operation: () => Promise<Result> | Result): Promise<Result> {
    const previous = this.stateQueues.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    this.stateQueues.set(key, queued);
    queued.finally(() => {
      if (this.stateQueues.get(key) === queued) this.stateQueues.delete(key);
    }).catch(() => undefined);
    return queued;
  }
}

export function createDatabaseFromEnvironment(env: NodeJS.ProcessEnv = process.env): StateDatabase {
  if (env.NODE_ENV === "test" && env.BIRDBOX_DATABASE_URL === "memory:") return new MemoryDatabase();
  const configuration = mysqlConfiguration(env);
  return new MySqlDatabase(configuration, {
    connectionLimit: env.BIRDBOX_DB_POOL_SIZE ?? 10,
    connectRetries: env.BIRDBOX_DB_CONNECT_RETRIES ?? DEFAULT_CONNECT_RETRIES,
    connectRetryMs: env.BIRDBOX_DB_CONNECT_RETRY_MS ?? DEFAULT_CONNECT_RETRY_MS,
    ssl: env.BIRDBOX_DB_SSL === "true",
  });
}
