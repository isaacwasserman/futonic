/**
 * Kysely instance factory with dialect auto-detection.
 *
 * Forked from better-auth's `packages/kysely-adapter/src/dialect.ts` (MIT).
 * Adapted to work standalone without BetterAuthOptions — accepts raw driver
 * instances or Kysely Dialect objects directly.
 */

import type { MySqlDatabase } from "drizzle-orm/mysql-core";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Dialect } from "kysely";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";

export type KyselyDatabaseType = "sqlite" | "mysql" | "postgres";

/**
 * The underlying driver a service opens its Kysely instance from. The host never
 * passes one of these directly — futonic reads it off a Drizzle instance's
 * `$client` (see {@link DrizzleDatabase}) — but the driver shape still has to be
 * detected, since Drizzle erases which driver produced it.
 *
 * The driver packages (`pg`, `mysql2`, `better-sqlite3`, …) are optional peer
 * dependencies, so rather than importing their types we describe each accepted
 * form structurally, keyed on the exact property `detectDatabaseType` sniffs.
 * This keeps the boundary strict without forcing a dependency on any one
 * driver's types.
 *
 * Accepted forms:
 * - A Kysely `Dialect` instance (most explicit; detected via `"createDriver"`)
 * - A `{ dialect: Dialect }` config object
 * - A `pg.Pool` (detected via `"connect"` property)
 * - A `mysql2` pool (detected via `"getConnection"` property)
 * - A `better-sqlite3` instance (detected via `"aggregate"` property)
 * - A Bun SQLite instance (detected via `"fileControl"` property)
 * - A Node built-in `DatabaseSync` (detected via `"open"`/`"close"`/`"prepare"`)
 * - A Cloudflare D1 binding (detected via `"batch"`/`"exec"`/`"prepare"`)
 */
export type DatabaseConnection =
	| Dialect
	| { dialect: Dialect }
	| PgPoolLike
	| Mysql2PoolLike
	| BetterSqlite3Like
	| BunSqliteLike
	| NodeSqliteLike
	| D1Like;

/** Minimal shape of a `pg.Pool`. */
export interface PgPoolLike {
	connect(...args: unknown[]): unknown;
}

/** Minimal shape of a `mysql2` connection pool. */
export interface Mysql2PoolLike {
	getConnection(...args: unknown[]): unknown;
}

/** Minimal shape of a `better-sqlite3` database instance. */
export interface BetterSqlite3Like {
	aggregate(...args: unknown[]): unknown;
}

/** Minimal shape of a Bun `bun:sqlite` database instance. */
export interface BunSqliteLike {
	fileControl(...args: unknown[]): unknown;
}

/** Minimal shape of a Node built-in `node:sqlite` `DatabaseSync`. */
export interface NodeSqliteLike {
	open(...args: unknown[]): unknown;
	close(...args: unknown[]): unknown;
	prepare(...args: unknown[]): unknown;
}

/** Minimal shape of a Cloudflare D1 database binding. */
export interface D1Like {
	batch(...args: unknown[]): unknown;
	exec(...args: unknown[]): unknown;
	prepare(...args: unknown[]): unknown;
}

/**
 * A Drizzle database instance — what the host passes as a service's `database`
 * config. Any `drizzle(...)` driver factory (`drizzle-orm/node-postgres`,
 * `drizzle-orm/mysql2`, `drizzle-orm/better-sqlite3`, `drizzle-orm/bun-sqlite`,
 * …) returns one of these.
 *
 * futonic doesn't query through Drizzle; it reads the underlying driver off
 * `$client` and opens its own Kysely connection. `$client` is attached at
 * runtime by every `drizzle()` factory but only appears on the intersection
 * type each factory returns, so we re-declare it over the base classes here.
 *
 * The generic parameters are left open (`any`) on purpose: a service accepts a
 * host's Drizzle instance regardless of which schema/driver it was built with.
 */
export type DrizzleDatabase =
	// biome-ignore lint/suspicious/noExplicitAny: accept any host Drizzle instance
	| (PgDatabase<any> & { $client: DatabaseConnection })
	// biome-ignore lint/suspicious/noExplicitAny: accept any host Drizzle instance
	| (MySqlDatabase<any, any> & { $client: DatabaseConnection })
	// biome-ignore lint/suspicious/noExplicitAny: accept any host Drizzle instance
	| (BaseSQLiteDatabase<any, any> & { $client: DatabaseConnection });

/**
 * Extracts the underlying driver from a Drizzle instance so futonic can open its
 * own Kysely connection from it.
 */
export function extractDatabaseClient(db: DrizzleDatabase): DatabaseConnection {
	const client = (db as { $client?: DatabaseConnection }).$client;
	if (!client) {
		throw new Error(
			"The provided `database` is not a Drizzle instance with a `$client` " +
				"(pass the value returned by `drizzle(...)`).",
		);
	}
	return client;
}

/**
 * Detects the database type from a driver instance using property sniffing.
 *
 * Forked from better-auth `getKyselyDatabaseType()`.
 */
export function detectDatabaseType(
	db: DatabaseConnection,
): KyselyDatabaseType | null {
	if (!db) return null;

	// Already a Kysely Dialect
	if ("createDriver" in db) {
		if (db instanceof SqliteDialect) return "sqlite";
		if (db instanceof MysqlDialect) return "mysql";
		if (db instanceof PostgresDialect) return "postgres";
	}

	// better-sqlite3: has `aggregate`, `pragma`, `backup`, etc.
	if ("aggregate" in db) return "sqlite";

	// mysql2 pool: has `getConnection`
	if ("getConnection" in db) return "mysql";

	// pg.Pool: has `connect`
	if ("connect" in db) return "postgres";

	// Bun SQLite: has `fileControl`
	if ("fileControl" in db) return "sqlite";

	// Node built-in sqlite (DatabaseSync): has open, close, prepare
	if ("open" in db && "close" in db && "prepare" in db) return "sqlite";

	// Cloudflare D1: has batch, exec, prepare
	if ("batch" in db && "exec" in db && "prepare" in db) return "sqlite";

	return null;
}

/**
 * Creates a Kysely instance from the host's database connection.
 *
 * Forked from better-auth `createKyselyAdapter()`.
 * Auto-detects the dialect from the driver instance shape.
 */
export function createKyselyInstance(
	connection: DatabaseConnection,
): Kysely<Record<string, unknown>> {
	// If it's already a Kysely Dialect, use directly
	if ("createDriver" in connection) {
		return new Kysely({ dialect: connection as Dialect });
	}

	// If the user passes a pre-built { dialect } config object
	if (
		typeof connection === "object" &&
		connection !== null &&
		"dialect" in connection &&
		typeof connection.dialect === "object" &&
		"createDriver" in connection.dialect
	) {
		return new Kysely({ dialect: connection.dialect as Dialect });
	}

	const dbType = detectDatabaseType(connection);
	let dialect: Dialect;

	// The dialect has been resolved by property sniffing above; the driver's
	// exact type is intentionally not a dependency of this package, so cast the
	// connection to each constructor's expected shape at the point of use.
	switch (dbType) {
		case "sqlite": {
			// Bun SQLite (has `fileControl`) needs special handling
			// For now, standard better-sqlite3 path
			type SqliteDb = ConstructorParameters<
				typeof SqliteDialect
			>[0]["database"];
			if ("fileControl" in connection) {
				// Bun SQLite — SqliteDialect works with Bun's API
				dialect = new SqliteDialect({
					database: connection as unknown as SqliteDb,
				});
			} else {
				dialect = new SqliteDialect({
					database: connection as unknown as SqliteDb,
				});
			}
			break;
		}
		case "mysql": {
			// mysql2 pool — MysqlDialect expects { pool }
			type MysqlPool = ConstructorParameters<typeof MysqlDialect>[0]["pool"];
			dialect = new MysqlDialect({ pool: connection as MysqlPool });
			break;
		}
		case "postgres": {
			// pg.Pool — PostgresDialect expects { pool }
			type PostgresPool = ConstructorParameters<
				typeof PostgresDialect
			>[0]["pool"];
			dialect = new PostgresDialect({ pool: connection as PostgresPool });
			break;
		}
		default:
			throw new Error(
				"Could not detect database type from the provided connection. " +
					"Pass a pg.Pool, mysql2 pool, better-sqlite3 instance, or a Kysely Dialect.",
			);
	}

	return new Kysely({ dialect });
}
