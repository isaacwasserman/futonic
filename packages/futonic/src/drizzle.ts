/**
 * Drizzle schema generator. Builds a service's `ServiceDBSchema` into Drizzle
 * tables using the host's injected dialect module, so the tables use the host's
 * own drizzle-orm (no version coupling) and `drizzle-kit` can migrate them.
 */

import type {
	ColumnDefinition,
	ServiceDBSchema,
	TableDefinition,
} from "./db-schema";

/** Dialect identifier, aligned with the codebase's database provider. */
export type DrizzleDialect = "pg" | "mysql" | "sqlite";

/** The host-provided drizzle dialect module (e.g. `drizzle-orm/pg-core`). */
export type DrizzleBuilders = Record<string, unknown>;

/** The base table *class* a dialect module exports (`PgTable`, etc.). */
type BaseTableClassName<D extends DrizzleDialect> = D extends "pg"
	? "PgTable"
	: D extends "mysql"
		? "MySqlTable"
		: "SQLiteTable";

/** Any (abstract) class constructor, used to recover a class's instance type. */
// biome-ignore lint/suspicious/noExplicitAny: match any constructor's arguments
type AnyAbstractCtor<T> = abstract new (...args: any[]) => T;

/**
 * The host's base table type (`PgTable`, etc.), recovered from the injected
 * module's table class so it's nameable via the host's own drizzle-orm.
 */
// Mapped-type-in-`extends` is load-bearing: a plain constraint collapses the
// property access to `unknown` and yields `never`.
type HostTable<
	D extends DrizzleDialect,
	TDrizzle extends DrizzleBuilders,
> = TDrizzle extends {
	[K in BaseTableClassName<D>]: AnyAbstractCtor<infer T>;
}
	? T
	: never;

/** Return of `generateDrizzleSchema`: `${prefix}${TableName}` keyed host tables. */
export type InferDrizzleSchema<
	TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TPrefix extends string,
	TDrizzle extends DrizzleBuilders,
> = {
	[K in keyof TSchema["tables"] &
		string as `${TPrefix}${Capitalize<K>}`]: HostTable<D, TDrizzle>;
};

// --- Runtime --------------------------------------------------------------

// The injected builders are dialect-specific and untyped at this layer; the
// return type is recovered from the caller's concrete namespace above.
// biome-ignore lint/suspicious/noExplicitAny: injected drizzle builders
type AnyBuilders = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: dialect-specific column/table builder
type ColumnBuilder = any;

/**
 * Physical column name for a logical (camelCase) column key. The runtime Kysely
 * instance installs a `CamelCasePlugin`, so it queries snake_case columns; the
 * generated tables must use the same snake_case SQL names to match.
 */
function toSnakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Translates the schema's onDelete tokens to Drizzle's action strings. */
function toDrizzleAction(
	onDelete: "cascade" | "restrict" | "set-null",
): "cascade" | "restrict" | "set null" {
	return onDelete === "set-null" ? "set null" : onDelete;
}

/** Builds a scalar (non-enum) column from the injected dialect builders. */
function scalarColumn(
	dialect: DrizzleDialect,
	d: AnyBuilders,
	type: Exclude<ColumnDefinition["type"], "enum">,
	name: string,
): ColumnBuilder {
	if (dialect === "pg") {
		switch (type) {
			case "string":
				return d.text(name);
			case "integer":
				return d.integer(name);
			case "boolean":
				return d.boolean(name);
			case "timestamp":
				return d.timestamp(name);
			case "json":
				return d.jsonb(name);
			case "blob":
				return d.customType({ dataType: () => "bytea" })(name);
		}
	}
	if (dialect === "mysql") {
		switch (type) {
			case "string":
				return d.text(name);
			case "integer":
				return d.int(name);
			case "boolean":
				return d.boolean(name);
			case "timestamp":
				return d.datetime(name);
			case "json":
				return d.json(name);
			case "blob":
				return d.customType({ dataType: () => "blob" })(name);
		}
	}
	switch (type) {
		case "string":
			return d.text(name);
		case "integer":
			return d.integer(name);
		case "boolean":
			return d.integer(name, { mode: "boolean" });
		case "timestamp":
			return d.integer(name, { mode: "timestamp" });
		case "json":
			return d.text(name, { mode: "json" });
		case "blob":
			return d.blob(name);
	}
}

/** Builds a single Drizzle column, applying constraints and references. */
function buildColumn(
	dialect: DrizzleDialect,
	d: AnyBuilders,
	column: ColumnDefinition,
	columnName: string,
	tables: Record<string, ColumnBuilder>,
): ColumnBuilder {
	let builder: ColumnBuilder;
	if (column.type === "enum") {
		const values = (column.enumValues ?? []) as [string, ...string[]];
		builder = d.text(columnName, { enum: values });
	} else {
		builder = scalarColumn(dialect, d, column.type, columnName);
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

const TABLE_CTOR: Record<DrizzleDialect, string> = {
	pg: "pgTable",
	mysql: "mysqlTable",
	sqlite: "sqliteTable",
};

/**
 * Generates a record of Drizzle tables from a service DB schema, using the
 * host's injected dialect builders.
 *
 * @param serviceSchema The service's dialect-agnostic table definitions.
 * @param dialect       The target SQL dialect.
 * @param prefix        Prefixes both the record keys and the physical table
 *   names (`${prefix}_${name}`), matching the runtime's table scoping.
 * @param drizzle       The host's drizzle dialect module — e.g.
 *   `import * as pg from "drizzle-orm/pg-core"`. Determines the drizzle-orm
 *   version of the returned tables (runtime and types).
 */
export function generateDrizzleSchema<
	const TSchema extends ServiceDBSchema,
	D extends DrizzleDialect,
	TPrefix extends string,
	TDrizzle extends DrizzleBuilders,
>({
	serviceSchema,
	dialect,
	prefix,
	drizzle,
}: {
	serviceSchema: TSchema;
	dialect: D;
	prefix: TPrefix;
	drizzle: TDrizzle;
}): InferDrizzleSchema<TSchema, D, TPrefix, TDrizzle> {
	const d = drizzle as AnyBuilders;
	const constructTable = d[TABLE_CTOR[dialect]];
	if (typeof constructTable !== "function") {
		throw new Error(
			`Injected drizzle module is missing "${TABLE_CTOR[dialect]}" for dialect "${dialect}"`,
		);
	}

	// FK references are resolved by logical table name, so keep an internal map
	// keyed by that; the returned record is keyed by the prefixed name.
	const byLogicalName: Record<string, ColumnBuilder> = {};
	const result: Record<string, ColumnBuilder> = {};

	for (const [tableName, tableDef] of Object.entries(serviceSchema.tables)) {
		const def = tableDef as TableDefinition;
		const columns: Record<string, ColumnBuilder> = {};
		for (const [columnName, column] of Object.entries(def.columns)) {
			// Map key stays the logical (camelCase) name so FK lookups and the
			// returned table's properties match the schema; the physical SQL name
			// is snake_cased to match the runtime Kysely `CamelCasePlugin`.
			columns[columnName] = buildColumn(
				dialect,
				d,
				column,
				toSnakeCase(columnName),
				byLogicalName,
			);
		}
		const table = constructTable(`${prefix}_${def.name}`, columns);
		byLogicalName[tableName] = table;
		const capitalized = `${tableName.slice(0, 1).toUpperCase()}${tableName.slice(1)}`;
		result[`${prefix}${capitalized}`] = table;
	}

	return result as InferDrizzleSchema<TSchema, D, TPrefix, TDrizzle>;
}
