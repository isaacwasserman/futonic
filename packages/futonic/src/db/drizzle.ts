/**
 * Drizzle schema generator.
 *
 * Converts a service's dialect-agnostic `ServiceDBSchema` into a record of
 * Drizzle table objects for a specific SQL dialect. Downstream services wrap
 * `generateSchema` and re-export the result; hosts then feed those tables into
 * their own Drizzle schema so `drizzle-kit` can produce migrations.
 *
 * The return type is fully inferred from the schema: when the schema is passed
 * with literal types (a `const` binding or `satisfies ServiceDBSchema`), each
 * generated table carries its real Drizzle column types, so services can export
 * typed rows via `typeof tables.users.$inferSelect`.
 *
 * `drizzle-orm` is an optional peer dependency — importing this module (via the
 * `futonic/drizzle` entry point) only works when the host has it installed.
 */

import type { BuildColumns, ColumnBuilderBase, Table } from "drizzle-orm";
import {
	type MySqlTableWithColumns,
	boolean as mysqlBoolean,
	customType as mysqlCustomType,
	datetime as mysqlDatetime,
	int as mysqlInt,
	json as mysqlJson,
	mysqlTable,
	text as mysqlText,
} from "drizzle-orm/mysql-core";
import {
	type PgTableWithColumns,
	boolean as pgBoolean,
	customType as pgCustomType,
	integer as pgInteger,
	jsonb as pgJsonb,
	pgTable,
	text as pgText,
	timestamp as pgTimestamp,
} from "drizzle-orm/pg-core";
import {
	type SQLiteTableWithColumns,
	blob as sqliteBlob,
	integer as sqliteInteger,
	sqliteTable,
	text as sqliteText,
} from "drizzle-orm/sqlite-core";
import type { FieldDefinition, ServiceDBSchema } from "./schema";
import { prefixTableName } from "./schema";

/** Dialect identifier, aligned with the codebase's KyselyDatabaseType. */
export type DrizzleDialect = "postgres" | "mysql" | "sqlite";

// Column builders don't share a common chainable type across dialects, so the
// runtime constructs them dynamically; precise types are recovered at the type
// level from TYPE_MAP (see the inference helpers below).
// biome-ignore lint/suspicious/noExplicitAny: drizzle column builders are dialect-specific
type ColumnBuilder = any;
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

/**
 * Maps a dialect and a service field type to a dialect-specific column builder.
 *
 * Declared with `satisfies` (not an explicit annotation) so each factory's
 * precise return type is preserved for `ColumnBuilderFor` to recover.
 */
const TYPE_MAP = {
	postgres: {
		string: (n: string) => pgText(n),
		number: (n: string) => pgInteger(n),
		boolean: (n: string) => pgBoolean(n),
		date: (n: string) => pgTimestamp(n),
		json: (n: string) => pgJsonb(n),
		binary: (n: string) => pgBytea(n),
	},
	mysql: {
		string: (n: string) => mysqlText(n),
		number: (n: string) => mysqlInt(n),
		boolean: (n: string) => mysqlBoolean(n),
		date: (n: string) => mysqlDatetime(n),
		json: (n: string) => mysqlJson(n),
		binary: (n: string) => mysqlBlob(n),
	},
	sqlite: {
		string: (n: string) => sqliteText(n),
		number: (n: string) => sqliteInteger(n),
		boolean: (n: string) => sqliteInteger(n, { mode: "boolean" }),
		date: (n: string) => sqliteInteger(n, { mode: "timestamp" }),
		json: (n: string) => sqliteText(n, { mode: "json" }),
		binary: (n: string) => sqliteBlob(n),
	},
} satisfies Record<
	DrizzleDialect,
	Record<FieldDefinition["type"], (name: string) => ColumnBuilderBase>
>;

// --- Type-level inference -------------------------------------------------
// The runtime builds columns imperatively, which erases their types. These
// helpers mirror the runtime exactly to recompute the precise table types, so
// `generateSchema`'s return type supports `$inferSelect` / `$inferInsert`.

/** The initial column builder the runtime creates for a dialect + field type. */
type ColumnBuilderFor<
	D extends DrizzleDialect,
	TType extends FieldDefinition["type"],
> = ReturnType<(typeof TYPE_MAP)[D][TType]>;

/**
 * The select/insert-affecting modifiers a field applies, expressed as the `_`
 * config flags Drizzle reads (mirrors `NotNull`/`HasDefault`/`IsPrimaryKey`).
 */
type ColumnModifiers<F extends FieldDefinition> = (F extends {
	primaryKey: true;
}
	? { notNull: true; isPrimaryKey: true }
	: // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
		{}) &
	(F extends { required: true }
		? { notNull: true }
		: // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
			{}) &
	("defaultValue" extends keyof F
		? { hasDefault: true }
		: // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
			{});

/** A field's column builder with its constraints applied. */
type ColumnBuilderForField<
	D extends DrizzleDialect,
	F extends FieldDefinition,
> = ColumnBuilderFor<D, F["type"]> & { _: ColumnModifiers<F> };

/** The Drizzle column-builder map for a single table. */
type ColumnsMapForFields<
	D extends DrizzleDialect,
	TFields extends Record<string, FieldDefinition>,
> = { [K in keyof TFields]: ColumnBuilderForField<D, TFields[K]> };

/** The fully-typed Drizzle table for a dialect, name, and field set. */
type DrizzleTableFor<
	D extends DrizzleDialect,
	TName extends string,
	TFields extends Record<string, FieldDefinition>,
> = D extends "postgres"
	? PgTableWithColumns<{
			name: TName;
			schema: undefined;
			columns: BuildColumns<
				TName,
				ColumnsMapForFields<"postgres", TFields>,
				"pg"
			>;
			dialect: "pg";
		}>
	: D extends "mysql"
		? MySqlTableWithColumns<{
				name: TName;
				schema: undefined;
				columns: BuildColumns<
					TName,
					ColumnsMapForFields<"mysql", TFields>,
					"mysql"
				>;
				dialect: "mysql";
			}>
		: D extends "sqlite"
			? SQLiteTableWithColumns<{
					name: TName;
					schema: undefined;
					columns: BuildColumns<
						TName,
						ColumnsMapForFields<"sqlite", TFields>,
						"sqlite"
					>;
					dialect: "sqlite";
				}>
			: never;

/**
 * The record `generateSchema` returns: logical table name -> fully-typed
 * Drizzle table, with SQL names prefixed by the service id.
 */
export type InferDrizzleSchema<
	TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TServiceId extends string,
> = {
	[K in keyof TSchema["tables"] & string]: DrizzleTableFor<
		D,
		`${TServiceId}_${K}`,
		TSchema["tables"][K]["fields"]
	>;
};

// --- Runtime --------------------------------------------------------------

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
	tables: Record<string, ColumnBuilder>,
): ColumnBuilder {
	const factory = TYPE_MAP[dialect][field.type];
	if (!factory) {
		throw new Error(
			`Unsupported field type "${field.type}" for dialect "${dialect}"`,
		);
	}

	let column: ColumnBuilder = factory(columnName);

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
				const target = tables[model];
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
 * Generates a record of fully-typed Drizzle tables from a service DB schema.
 *
 * @param schema    The service's dialect-agnostic table definitions. Pass it as
 *   a `const` binding (or with `satisfies ServiceDBSchema`) to get precise
 *   per-column types on the result.
 * @param dialect   The target SQL dialect.
 * @param serviceId Prefixes the emitted SQL table names (mirroring the runtime's
 *   table scoping); the returned record stays keyed by the logical table names.
 */
export function generateSchema<
	const TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TServiceId extends string,
>(
	schema: TSchema,
	dialect: D,
	serviceId: TServiceId,
): InferDrizzleSchema<TSchema, D, TServiceId> {
	const constructTable = TABLE_CONSTRUCTORS[dialect];
	if (!constructTable) {
		throw new Error(`Unsupported dialect "${dialect}"`);
	}

	const tables: Record<string, Table> = {};

	for (const [tableName, tableDef] of Object.entries(schema.tables)) {
		const columns: Record<string, ColumnBuilder> = {};
		for (const [fieldName, field] of Object.entries(tableDef.fields)) {
			columns[fieldName] = buildColumn(dialect, field, fieldName, tables);
		}

		const sqlName = prefixTableName(serviceId, tableName);
		tables[tableName] = constructTable(sqlName, columns);
	}

	return tables as unknown as InferDrizzleSchema<TSchema, D, TServiceId>;
}
