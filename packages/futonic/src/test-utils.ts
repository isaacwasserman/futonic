/**
 * Portable SQLite helper for tests.
 *
 * Detects the runtime and provides a unified SQLite database that works
 * with Kysely's SqliteDialect under both Bun and Node.
 *
 * - Bun: uses bun:sqlite with a compatibility wrapper (adds `stmt.reader`)
 * - Node: uses better-sqlite3 directly
 */

import { Kysely, SqliteDialect } from "kysely";
import type { DrizzleDatabase } from "./db/kysely-factory";

export interface TestDatabase {
	/** Run a SQL statement (DDL / DML) */
	run(sql: string): void;
	/** The underlying database to pass to SqliteDialect */
	raw: unknown;
	/** A Drizzle instance wrapping this database (what services receive) */
	drizzle: DrizzleDatabase;
	/** A Kysely instance wrapping this database */
	kysely: Kysely<Record<string, unknown>>;
	/** Clean up */
	close(): Promise<void>;
}

const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Creates an in-memory SQLite database compatible with Kysely's SqliteDialect.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
	if (isBun) {
		return createBunDatabase();
	}
	return createNodeDatabase();
}

/**
 * bun:sqlite wrapper that patches stmt.reader for Kysely compatibility.
 *
 * Kysely's SqliteDriver checks `stmt.reader` to distinguish SELECT queries
 * from writes. bun:sqlite doesn't have this property, so all queries are
 * treated as writes and return empty rows. We wrap `db.prepare()` to add it.
 */
async function createBunDatabase(): Promise<TestDatabase> {
	const { Database } = await import("bun:sqlite");
	const inner = new Database(":memory:");

	// Wrap to add .reader property on prepared statements
	const wrapped = new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "prepare") {
				return (sql: string) => {
					const stmt = target.prepare(sql);
					const trimmed = sql.trimStart().toUpperCase();
					const isReader =
						trimmed.startsWith("SELECT") ||
						trimmed.startsWith("WITH") ||
						trimmed.startsWith("PRAGMA");

					// RETURNING clauses make writes behave as readers
					const hasReturning = /\bRETURNING\b/i.test(sql);

					return new Proxy(stmt, {
						get(stmtTarget, stmtProp) {
							if (stmtProp === "reader") return isReader || hasReturning;
							const val = (stmtTarget as any)[stmtProp];
							if (typeof val === "function") {
								return val.bind(stmtTarget);
							}
							return val;
						},
					});
				};
			}
			const val = (target as any)[prop];
			if (typeof val === "function") {
				return val.bind(target);
			}
			return val;
		},
	});

	const kysely = new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({ database: wrapped as any }),
	});

	const { drizzle } = await import("drizzle-orm/bun-sqlite");
	const drizzleDb = drizzle(wrapped as any);

	return {
		run: (sql: string) => inner.run(sql),
		raw: wrapped,
		drizzle: drizzleDb,
		kysely,
		async close() {
			await kysely.destroy();
			inner.close();
		},
	};
}

async function createNodeDatabase(): Promise<TestDatabase> {
	const Database = (await import("better-sqlite3")).default;
	const db = new Database(":memory:");

	const kysely = new Kysely<Record<string, unknown>>({
		dialect: new SqliteDialect({ database: db }),
	});

	const { drizzle } = await import("drizzle-orm/better-sqlite3");
	const drizzleDb = drizzle(db);

	return {
		run: (sql: string) => db.exec(sql),
		raw: db,
		drizzle: drizzleDb,
		kysely,
		async close() {
			await kysely.destroy();
			db.close();
		},
	};
}
