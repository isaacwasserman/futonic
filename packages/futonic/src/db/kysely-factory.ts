/**
 * Kysely instance factory with dialect auto-detection.
 *
 * Forked from better-auth's `packages/kysely-adapter/src/dialect.ts` (MIT).
 * Adapted to work standalone without BetterAuthOptions — accepts raw driver
 * instances or Kysely Dialect objects directly.
 */

import type { Dialect } from "kysely";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";

export type KyselyDatabaseType = "sqlite" | "mysql" | "postgres";

/**
 * The host passes one of these to `createHost({ database: ... })`.
 *
 * Accepted forms:
 * - A Kysely `Dialect` instance (most explicit)
 * - A `pg.Pool` (detected via `"connect"` property)
 * - A `mysql2` pool (detected via `"getConnection"` property)
 * - A `better-sqlite3` instance (detected via `"aggregate"` property)
 * - A Bun SQLite instance (detected via `"fileControl"` property)
 */
// biome-ignore lint/suspicious/noExplicitAny: must accept unknown driver shapes
export type DatabaseConnection = any;

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

	switch (dbType) {
		case "sqlite": {
			// Bun SQLite (has `fileControl`) needs special handling
			// For now, standard better-sqlite3 path
			if ("fileControl" in connection) {
				// Bun SQLite — SqliteDialect works with Bun's API
				dialect = new SqliteDialect({ database: connection });
			} else {
				dialect = new SqliteDialect({ database: connection });
			}
			break;
		}
		case "mysql": {
			// mysql2 pool — MysqlDialect expects { pool }
			dialect = new MysqlDialect({ pool: connection });
			break;
		}
		case "postgres": {
			// pg.Pool — PostgresDialect expects { pool }
			dialect = new PostgresDialect({ pool: connection });
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
