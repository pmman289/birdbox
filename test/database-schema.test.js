import test from "node:test";
import assert from "node:assert/strict";

import { validateMySqlTableContract } from "../src/database.js";

function column(
  name,
  type,
  position,
  {
    nullable = "NO",
    defaultValue = null,
    extra = "",
    characterSet = null,
    collation = null,
  } = {},
) {
  return {
    COLUMN_NAME: name,
    COLUMN_TYPE: type,
    IS_NULLABLE: nullable,
    COLUMN_DEFAULT: defaultValue,
    EXTRA: extra,
    CHARACTER_SET_NAME: characterSet,
    COLLATION_NAME: collation,
    ORDINAL_POSITION: position,
  };
}

function primaryKey(columnName) {
  return {
    INDEX_NAME: "PRIMARY",
    NON_UNIQUE: 0,
    SEQ_IN_INDEX: 1,
    COLUMN_NAME: columnName,
    SUB_PART: null,
    INDEX_TYPE: "BTREE",
  };
}

function stateTableMetadata() {
  return {
    tables: [{ ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_unicode_ci" }],
    columns: [
      column("state_key", "varchar(64)", 1, { characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("revision", "bigint unsigned", 2, { defaultValue: "1" }),
      column("document", "json", 3),
      column("created_at", "timestamp(3)", 4, {
        defaultValue: "CURRENT_TIMESTAMP(3)",
        extra: "DEFAULT_GENERATED",
      }),
      column("updated_at", "timestamp(3)", 5, {
        defaultValue: "CURRENT_TIMESTAMP(3)",
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)",
      }),
    ],
    indexes: [primaryKey("state_key")],
  };
}

function migrationTableMetadata() {
  return {
    tables: [{ ENGINE: "InnoDB", TABLE_COLLATION: "utf8mb4_unicode_ci" }],
    columns: [
      column("version", "int unsigned", 1),
      column("name", "varchar(128)", 2, { characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" }),
      column("applied_at", "timestamp(3)", 3, {
        defaultValue: "CURRENT_TIMESTAMP(3)",
        extra: "DEFAULT_GENERATED",
      }),
    ],
    indexes: [primaryKey("version")],
  };
}

function assertInvalid(tableName, metadata) {
  assert.throws(
    () => validateMySqlTableContract(tableName, metadata),
    (error) => error.code === "DATABASE_SCHEMA_INVALID" && error.status === 500,
  );
}

test("accepts the exact state and migration table contracts reported by MySQL", () => {
  assert.doesNotThrow(() => validateMySqlTableContract("birdbox_state", stateTableMetadata()));
  assert.doesNotThrow(() => validateMySqlTableContract("birdbox_schema_migrations", migrationTableMetadata()));
});

test("rejects unsafe state table engine, columns, defaults, and update behavior", () => {
  const wrongEngine = stateTableMetadata();
  wrongEngine.tables[0].ENGINE = "MyISAM";
  assertInvalid("birdbox_state", wrongEngine);

  const nullableDocument = stateTableMetadata();
  nullableDocument.columns[2].IS_NULLABLE = "YES";
  assertInvalid("birdbox_state", nullableDocument);

  const wrongRevisionDefault = stateTableMetadata();
  wrongRevisionDefault.columns[1].COLUMN_DEFAULT = "0";
  assertInvalid("birdbox_state", wrongRevisionDefault);

  const missingTimestampUpdate = stateTableMetadata();
  missingTimestampUpdate.columns[4].EXTRA = "DEFAULT_GENERATED";
  assertInvalid("birdbox_state", missingTimestampUpdate);

  const unexpectedColumn = stateTableMetadata();
  unexpectedColumn.columns.push(column("unmanaged", "varchar(10)", 6, { nullable: "YES" }));
  assertInvalid("birdbox_state", unexpectedColumn);
});

test("rejects incompatible primary keys and additional unique constraints", () => {
  const wrongPrimaryKey = stateTableMetadata();
  wrongPrimaryKey.indexes[0].COLUMN_NAME = "revision";
  assertInvalid("birdbox_state", wrongPrimaryKey);

  const prefixedPrimaryKey = stateTableMetadata();
  prefixedPrimaryKey.indexes[0].SUB_PART = 32;
  assertInvalid("birdbox_state", prefixedPrimaryKey);

  const additionalUniqueIndex = stateTableMetadata();
  additionalUniqueIndex.indexes.push({
    ...primaryKey("revision"),
    INDEX_NAME: "unique_revision",
  });
  assertInvalid("birdbox_state", additionalUniqueIndex);

  const wrongMigrationPrimaryKey = migrationTableMetadata();
  wrongMigrationPrimaryKey.indexes[0].COLUMN_NAME = "name";
  assertInvalid("birdbox_schema_migrations", wrongMigrationPrimaryKey);
});

test("rejects migration-table contract drift before migration rows are trusted", () => {
  const nullableMigrationName = migrationTableMetadata();
  nullableMigrationName.columns[1].IS_NULLABLE = "YES";
  assertInvalid("birdbox_schema_migrations", nullableMigrationName);

  const wrongAppliedAtDefault = migrationTableMetadata();
  wrongAppliedAtDefault.columns[2].COLUMN_DEFAULT = null;
  assertInvalid("birdbox_schema_migrations", wrongAppliedAtDefault);

  const wrongCollation = migrationTableMetadata();
  wrongCollation.tables[0].TABLE_COLLATION = "utf8mb4_0900_ai_ci";
  assertInvalid("birdbox_schema_migrations", wrongCollation);
});
