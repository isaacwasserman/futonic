/**
 * Drizzle schema generator.
 *
 * Converts a service's dialect-agnostic `ServiceDBSchema` into a record of
 * Drizzle table objects for a specific SQL dialect. Hosts feed those tables
 * into their own Drizzle schema so `drizzle-kit` can produce migrations.
 */

import type {
	BuildColumns,
	ColumnBuilderBase,
	Relations,
	Table,
	View,
} from "drizzle-orm";
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
	type PgEnum,
	type PgSequence,
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
import type {
	ColumnDefinition,
	ServiceDBSchema,
	TableDefinition,
} from "./db-schema";

/**
 * A top-level member of a Drizzle schema object. Drizzle ships no union for
 * this (its own API just uses `Record<string, unknown>`), so we assemble it
 * from the exported member classes: tables, relations, views, and — Postgres
 * only — enums and sequences.
 */
export type DrizzleSchemaMember =
	| Table
	| Relations
	| View
	| PgEnum<[string, ...string[]]>
	| PgSequence;

/** A Drizzle schema object: a string-keyed set of tables, enums, etc. */
export type DrizzleSchema = Record<string, DrizzleSchemaMember>;

/** Dialect identifier, aligned with the codebase's database provider. */
export type DrizzleDialect = "pg" | "mysql" | "sqlite";

/** A `ColumnDefinition` type other than `"enum"` (enum needs its values). */
type ScalarColumnType = Exclude<ColumnDefinition["type"], "enum">;

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

const TABLE_CONSTRUCTORS: Record<DrizzleDialect, TableConstructor> = {
	pg: (name, columns) => pgTable(name, columns),
	mysql: (name, columns) => mysqlTable(name, columns),
	sqlite: (name, columns) => sqliteTable(name, columns),
};

/**
 * Maps a dialect and a scalar column type to a dialect-specific column builder.
 *
 * Declared with `satisfies` (not an explicit annotation) so each factory's
 * precise return type is preserved for `ColumnBuilderFor` to recover.
 */
const TYPE_MAP = {
	pg: {
		string: (n: string) => pgText(n),
		integer: (n: string) => pgInteger(n),
		boolean: (n: string) => pgBoolean(n),
		timestamp: (n: string) => pgTimestamp(n),
		json: (n: string) => pgJsonb(n),
		blob: (n: string) => pgBytea(n),
	},
	mysql: {
		string: (n: string) => mysqlText(n),
		integer: (n: string) => mysqlInt(n),
		boolean: (n: string) => mysqlBoolean(n),
		timestamp: (n: string) => mysqlDatetime(n),
		json: (n: string) => mysqlJson(n),
		blob: (n: string) => mysqlBlob(n),
	},
	sqlite: {
		string: (n: string) => sqliteText(n),
		integer: (n: string) => sqliteInteger(n),
		boolean: (n: string) => sqliteInteger(n, { mode: "boolean" }),
		timestamp: (n: string) => sqliteInteger(n, { mode: "timestamp" }),
		json: (n: string) => sqliteText(n, { mode: "json" }),
		blob: (n: string) => sqliteBlob(n),
	},
} satisfies Record<
	DrizzleDialect,
	Record<ScalarColumnType, (name: string) => ColumnBuilderBase>
>;

/** Builds an `enum` column as a text column constrained to its values. */
const ENUM_BUILDERS: Record<
	DrizzleDialect,
	(name: string, values: [string, ...string[]]) => ColumnBuilder
> = {
	pg: (n, values) => pgText(n, { enum: values }),
	mysql: (n, values) => mysqlText(n, { enum: values }),
	sqlite: (n, values) => sqliteText(n, { enum: values }),
};

// --- Type-level inference -------------------------------------------------
// The runtime builds columns imperatively, which erases their types. These
// helpers mirror the runtime exactly to recompute the precise table types, so
// the return type supports `$inferSelect` / `$inferInsert`.

/**
 * The initial column builder the runtime creates for a dialect + column type.
 * `enum` degrades to the string/text builder (its literal union isn't recovered
 * because `ColumnDefinition.enumValues` isn't captured generically).
 */
type ColumnBuilderFor<
	D extends DrizzleDialect,
	TType extends ColumnDefinition["type"],
> = TType extends ScalarColumnType
	? ReturnType<(typeof TYPE_MAP)[D][TType]>
	: ReturnType<(typeof TYPE_MAP)[D]["string"]>;

/**
 * The select/insert-affecting modifiers a column applies, expressed as the `_`
 * config flags Drizzle reads (mirrors `NotNull`/`HasDefault`/`IsPrimaryKey`).
 * A column is NOT NULL unless it is explicitly `optional`.
 */
type ColumnModifiers<C extends ColumnDefinition> = (C extends {
	primaryKey: true;
}
	? { notNull: true; isPrimaryKey: true }
	: // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
		{}) &
	(C extends { optional: true }
		? // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
			{}
		: { notNull: true }) &
	("defaultValue" extends keyof C
		? { hasDefault: true }
		: // biome-ignore lint/complexity/noBannedTypes: empty intersection member is intentional
			{});

/** A column's builder with its constraints applied. */
type ColumnBuilderForColumn<
	D extends DrizzleDialect,
	C extends ColumnDefinition,
> = ColumnBuilderFor<D, C["type"]> & { _: ColumnModifiers<C> };

/** The Drizzle column-builder map for a single table. */
type ColumnsMapForColumns<
	D extends DrizzleDialect,
	TColumns extends Record<string, ColumnDefinition>,
> = { [K in keyof TColumns]: ColumnBuilderForColumn<D, TColumns[K]> };

/** The fully-typed Drizzle table for a dialect, name, and column set. */
type DrizzleTableFor<
	D extends DrizzleDialect,
	TName extends string,
	TColumns extends Record<string, ColumnDefinition>,
> = D extends "pg"
	? PgTableWithColumns<{
			name: TName;
			schema: undefined;
			columns: BuildColumns<TName, ColumnsMapForColumns<"pg", TColumns>, "pg">;
			dialect: "pg";
		}>
	: D extends "mysql"
		? MySqlTableWithColumns<{
				name: TName;
				schema: undefined;
				columns: BuildColumns<
					TName,
					ColumnsMapForColumns<"mysql", TColumns>,
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
						ColumnsMapForColumns<"sqlite", TColumns>,
						"sqlite"
					>;
					dialect: "sqlite";
				}>
			: never;

/**
 * The record `generateDrizzleSchema` returns. Each key is the service prefix
 * followed by the capitalized logical table name (e.g. `ticketingTickets`), and
 * each table's SQL name is prefixed as `${prefix}_${name}` — mirroring the
 * runtime exactly so both the record keys and column types stay type-safe.
 */
export type InferDrizzleSchema<
	TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TPrefix extends string,
> = {
	[K in keyof TSchema["tables"] &
		string as `${TPrefix}${Capitalize<K>}`]: DrizzleTableFor<
		D,
		`${TPrefix}_${TSchema["tables"][K]["name"] & string}`,
		TSchema["tables"][K]["columns"]
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
	column: ColumnDefinition,
	columnName: string,
	tables: Record<string, ColumnBuilder>,
): ColumnBuilder {
	let builder: ColumnBuilder;
	if (column.type === "enum") {
		const values = (column.enumValues ?? []) as [string, ...string[]];
		builder = ENUM_BUILDERS[dialect](columnName, values);
	} else {
		const factory = TYPE_MAP[dialect][column.type];
		if (!factory) {
			throw new Error(
				`Unsupported column type "${column.type}" for dialect "${dialect}"`,
			);
		}
		builder = factory(columnName);
	}

	if (column.primaryKey) builder = builder.primaryKey();
	if (!column.optional) builder = builder.notNull();
	if (column.defaultValue !== undefined)
		builder = builder.default(column.defaultValue);

	if (column.references) {
		const { table, column: refColumn, onDelete } = column.references;
		builder = builder.references(
			// Resolved lazily so referenced tables need not be built first.
			() => {
				const target = tables[table];
				if (!target) {
					throw new Error(
						`Column "${columnName}" references unknown table "${table}"`,
					);
				}
				return target[refColumn];
			},
			onDelete ? { onDelete: toDrizzleAction(onDelete) } : undefined,
		);
	}

	return builder;
}

/**
 * Generates a record of fully-typed Drizzle tables from a service DB schema.
 *
 * @param serviceSchema The service's dialect-agnostic table definitions. Pass
 *   it as a `const` binding (or with `satisfies ServiceDBSchema`) to get precise
 *   per-column types on the result.
 * @param dialect       The target SQL dialect.
 */
export function generateDrizzleSchema<
	const TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TPrefix extends string,
>({
	serviceSchema,
	dialect,
	prefix,
}: {
	serviceSchema: TSchema;
	dialect: D;
	prefix: TPrefix;
}): InferDrizzleSchema<TSchema, D, TPrefix> {
	const constructTable = TABLE_CONSTRUCTORS[dialect];
	if (!constructTable) {
		throw new Error(`Unsupported dialect "${dialect}"`);
	}

	// FK references are resolved by logical table name, so keep an internal map
	// keyed by that; the returned record is keyed by the prefixed name.
	const byLogicalName: Record<string, Table> = {};
	const result: Record<string, Table> = {};

	for (const [tableName, tableDef] of Object.entries(serviceSchema.tables)) {
		const def = tableDef as TableDefinition;
		const columns: Record<string, ColumnBuilder> = {};
		for (const [columnName, column] of Object.entries(def.columns)) {
			columns[columnName] = buildColumn(
				dialect,
				column,
				columnName,
				byLogicalName,
			);
		}
		const table = constructTable(`${prefix}_${def.name}`, columns);
		byLogicalName[tableName] = table;
		const capitalized = `${tableName.slice(0, 1).toUpperCase()}${tableName.slice(1)}`;
		result[`${prefix}${capitalized}`] = table;
	}

	return result as unknown as InferDrizzleSchema<TSchema, D, TPrefix>;
}
