import {
	CamelCasePlugin,
	type Dialect,
	Kysely,
	MysqlDialect,
	type MysqlPool,
	PostgresDialect,
	type PostgresPool,
	type SqliteDatabase,
	SqliteDialect,
} from "kysely";
import type {
	ColumnDefinition,
	ServiceDBSchema,
	TableDefinition,
} from "./db-schema";

type ScalarColumnType<C extends ColumnDefinition> = C["type"] extends "string"
	? string
	: C["type"] extends "integer"
		? number
		: C["type"] extends "boolean"
			? boolean
			: C["type"] extends "timestamp"
				? Date
				: C["type"] extends "json"
					? unknown
					: C["type"] extends "blob"
						? Uint8Array
						: C["type"] extends "enum"
							? C["enumValues"] extends readonly (infer E)[]
								? E
								: string
							: never;

type ColumnValueType<C extends ColumnDefinition> = C["optional"] extends true
	? ScalarColumnType<C> | null
	: ScalarColumnType<C>;

type RowType<T extends TableDefinition> = {
	[K in keyof T["columns"]]: ColumnValueType<T["columns"][K]>;
};

/**
 * The Kysely schema mirrors the Drizzle schema's *JS* keys: each logical table
 * key `K` is exposed as `${TPrefix}${Capitalize<K>}` (e.g. `ticketingTickets`).
 *
 * The generated DDL names physical tables `${prefix}_${name}` (snake_case), so
 * the `CamelCasePlugin` on the Kysely instance rewrites the prefixed camelCase
 * key back to that snake_case physical name at query time. Keying by the bare
 * logical name would query the unprefixed table and miss the real one.
 */
type KyselySchema<S extends ServiceDBSchema, TPrefix extends string> = {
	[TableName in keyof S["tables"] &
		string as `${TPrefix}${Capitalize<TableName>}`]: RowType<
		S["tables"][TableName]
	>;
};

export type KyselyFromServiceDBSchema<
	S extends ServiceDBSchema,
	TPrefix extends string = string,
> = Kysely<KyselySchema<S, TPrefix>>;

/**
 * Which driver family the raw connection belongs to. Selects the Kysely dialect
 * (and therefore which member of `DatabaseConnection` is expected).
 */
export type DatabaseProvider = "pg" | "mysql" | "sqlite";

/**
 * The raw driver connection the caller passes in, per provider (each is one of
 * Kysely's own driver interfaces, so no concrete driver package is required):
 *   - `pg`     → `PostgresPool`   (e.g. node-postgres `Pool`)
 *   - `mysql`  → `MysqlPool`      (e.g. mysql2 `Pool`)
 *   - `sqlite` → `SqliteDatabase` (any better-sqlite3-compatible database)
 */
export type DatabaseConnection = PostgresPool | MysqlPool | SqliteDatabase;

/**
 * Build a typed Kysely instance for a provider.
 *
 * A `CamelCasePlugin` is always installed so endpoints query in camelCase while
 * the underlying (snake_case) tables/columns stay untouched.
 */
export function createKysely<
	TDBSchema extends ServiceDBSchema,
	TPrefix extends string = string,
>(
	connection: DatabaseConnection,
	provider: DatabaseProvider,
): KyselyFromServiceDBSchema<TDBSchema, TPrefix> {
	let dialect: Dialect;
	switch (provider) {
		case "pg":
			dialect = new PostgresDialect({ pool: connection as PostgresPool });
			break;
		case "mysql":
			dialect = new MysqlDialect({ pool: connection as MysqlPool });
			break;
		case "sqlite":
			dialect = new SqliteDialect({ database: connection as SqliteDatabase });
			break;
	}

	return new Kysely({
		dialect,
		plugins: [new CamelCasePlugin()],
	}) as KyselyFromServiceDBSchema<TDBSchema, TPrefix>;
}
