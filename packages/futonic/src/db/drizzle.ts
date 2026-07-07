/**
 * Drizzle schema generator.
 *
 * Converts a service's dialect-agnostic `ServiceDBSchema` into a record of
 * Drizzle table objects for a specific SQL dialect. Downstream services wrap
 * `generateSchema` and re-export the result; hosts then feed those tables into
 * their own Drizzle schema so `drizzle-kit` can produce migrations.
 *
 * `drizzle-orm` is an optional peer dependency — importing this module (via the
 * `futonic/drizzle` entry point) only works when the host has it installed.
 */

import type { Table } from "drizzle-orm";
import {
	boolean as mysqlBoolean,
	customType as mysqlCustomType,
	datetime as mysqlDatetime,
	int as mysqlInt,
	json as mysqlJson,
	mysqlTable,
	text as mysqlText,
} from "drizzle-orm/mysql-core";
import {
	boolean as pgBoolean,
	customType as pgCustomType,
	integer as pgInteger,
	jsonb as pgJsonb,
	pgTable,
	text as pgText,
	timestamp as pgTimestamp,
} from "drizzle-orm/pg-core";
import {
	blob as sqliteBlob,
	integer as sqliteInteger,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm/sqlite-core";
import type { FieldDefinition, ServiceDBSchema } from "./schema";
import { prefixTableName } from "./schema";

/** Dialect identifier, aligned with the codebase's KyselyDatabaseType. */
export type DrizzleDialect = "postgres" | "mysql" | "sqlite";

/** The map returned by generateSchema: logical table name -> Drizzle table. */
export type GeneratedDrizzleSchema = Record<string, Table>;

// Column builders don't share a common chainable type across dialects, so the
// mapping values are intentionally loose.
// biome-ignore lint/suspicious/noExplicitAny: drizzle column builders are dialect-specific
type ColumnBuilder = any;
type ColumnFactory = (name: string) => ColumnBuilder;
type TableConstructor = (
	name: string,
	columns: Record<string, ColumnBuilder>,
) => Table;

// Postgres has no first-class binary column builder; MySQL exposes only
// fixed/var-length binaries. Model both as raw dialect types via customType.
const pgBytea = pgCustomType<{ data: Buffer }>({ dataType: () => "bytea" });
const mysqlBlob = mysqlCustomType<{ data: Buffer }>({ dataType: () => "blob" });

/** Maps a dialect to its Drizzle table constructor. */
const TABLE_CONSTRUCTORS: Record<DrizzleDialect, TableConstructor> = {
	postgres: (name, columns) => pgTable(name, columns),
	mysql: (name, columns) => mysqlTable(name, columns),
	sqlite: (name, columns) => sqliteTable(name, columns),
};

/** Maps a dialect and a service field type to a dialect-specific column. */
const TYPE_MAP: Record<
	DrizzleDialect,
	Record<FieldDefinition["type"], ColumnFactory>
> = {
	postgres: {
		string: (n) => pgText(n),
		number: (n) => pgInteger(n),
		boolean: (n) => pgBoolean(n),
		date: (n) => pgTimestamp(n),
		json: (n) => pgJsonb(n),
		binary: (n) => pgBytea(n),
	},
	mysql: {
		string: (n) => mysqlText(n),
		number: (n) => mysqlInt(n),
		boolean: (n) => mysqlBoolean(n),
		date: (n) => mysqlDatetime(n),
		json: (n) => mysqlJson(n),
		binary: (n) => mysqlBlob(n),
	},
	sqlite: {
		string: (n) => sqliteText(n),
		number: (n) => sqliteInteger(n),
		boolean: (n) => sqliteInteger(n, { mode: "boolean" }),
		date: (n) => sqliteInteger(n, { mode: "timestamp" }),
		json: (n) => sqliteText(n, { mode: "json" }),
		binary: (n) => sqliteBlob(n),
	},
};

/** Translates the schema's onDelete tokens to Drizzle's action strings. */
function toDrizzleAction(
	onDelete: "cascade" | "restrict" | "set-null",
): "cascade" | "restrict" | "set null" {
	return onDelete === "set-null" ? "set null" : onDelete;
}

/** Builds a single Drizzle column, applying constraints and references. */
function buildColumn(
	dialect: DrizzleDialect,
	field: FieldDefinition,
	columnName: string,
	tables: GeneratedDrizzleSchema,
): ColumnBuilder {
	const factory = TYPE_MAP[dialect][field.type];
	if (!factory) {
		throw new Error(
			`Unsupported field type "${field.type}" for dialect "${dialect}"`,
		);
	}

	let column = factory(columnName);

	if (field.primaryKey) column = column.primaryKey();
	if (field.required) column = column.notNull();
	if (field.unique) column = column.unique();
	if (field.defaultValue !== undefined)
		column = column.default(field.defaultValue);

	if (field.references) {
		const { model, field: refField, onDelete } = field.references;
		column = column.references(
			// Resolved lazily so referenced tables need not be built first.
			() => {
				const target = tables[model] as
					| Record<string, ColumnBuilder>
					| undefined;
				if (!target) {
					throw new Error(
						`Field "${columnName}" references unknown table "${model}"`,
					);
				}
				return target[refField];
			},
			onDelete ? { onDelete: toDrizzleAction(onDelete) } : undefined,
		);
	}

	return column;
}

/**
 * Generates a record of Drizzle tables from a service DB schema for a dialect.
 *
 * @param schema    The service's dialect-agnostic table definitions.
 * @param dialect   The target SQL dialect.
 * @param serviceId Prefixes the emitted SQL table names (mirroring the runtime's
 *   table scoping); the returned record stays keyed by the logical table names.
 */
export function generateSchema(
	schema: ServiceDBSchema,
	dialect: DrizzleDialect,
	serviceId: string,
): GeneratedDrizzleSchema {
	const constructTable = TABLE_CONSTRUCTORS[dialect];
	if (!constructTable) {
		throw new Error(`Unsupported dialect "${dialect}"`);
	}

	const tables: GeneratedDrizzleSchema = {};

	for (const [tableName, tableDef] of Object.entries(schema.tables)) {
		const columns: Record<string, ColumnBuilder> = {};
		for (const [fieldName, field] of Object.entries(tableDef.fields)) {
			columns[fieldName] = buildColumn(dialect, field, fieldName, tables);
		}

		const sqlName = prefixTableName(serviceId, tableName);
		tables[tableName] = constructTable(sqlName, columns);
	}

	return tables;
}
