/**
 * Test-only helpers. Excluded from the build and typecheck (see tsconfig);
 * imported by `*.test.ts` files running under `bun test`.
 *
 * The library accepts any better-sqlite3-compatible `SqliteDatabase`; for our
 * own tests we back that with `bun:sqlite` (better-sqlite3's native addon can't
 * load under Bun's test runtime). Kysely's `SqliteDialect` reads `stmt.reader`
 * to tell SELECTs from writes, which `bun:sqlite` doesn't expose, so we add it
 * via a Proxy.
 */

import { Database } from "bun:sqlite";
import type { DatabaseConnection } from "./kysely";

/** An in-memory `bun:sqlite` connection shaped for Kysely's `SqliteDialect`. */
export function createSqliteConnection(): DatabaseConnection {
	const inner = new Database(":memory:");

	const wrapped = new Proxy(inner, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					const stmt = target.prepare(sql);
					const trimmed = sql.trimStart().toUpperCase();
					const isReader =
						trimmed.startsWith("SELECT") ||
						trimmed.startsWith("WITH") ||
						trimmed.startsWith("PRAGMA");
					const hasReturning = /\bRETURNING\b/i.test(sql);

					return new Proxy(stmt, {
						get(stmtTarget, stmtProp) {
							if (stmtProp === "reader") return isReader || hasReturning;
							// biome-ignore lint/suspicious/noExplicitAny: dynamic passthrough
							const value = (stmtTarget as any)[stmtProp];
							return typeof value === "function"
								? value.bind(stmtTarget)
								: value;
						},
					});
				};
			}
			// biome-ignore lint/suspicious/noExplicitAny: dynamic passthrough
			const value = (target as any)[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return wrapped as unknown as DatabaseConnection;
}
