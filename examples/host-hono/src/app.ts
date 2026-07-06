/**
 * App factory — creates the Hono app, database, and the billing service.
 *
 * Separated from index.ts so e2e tests can spin up isolated instances
 * with in-memory SQLite without starting a real TCP server.
 *
 * Note the host never imports "futonic" — it only knows about `service-billing`.
 */

import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { billing } from "service-billing";
import { SQLITE_UP } from "service-billing/src/migrations";

/** The billing service instance type, without importing futonic directly. */
export type BillingService = ReturnType<typeof billing>;

export interface App {
	/** Hono app — call app.fetch(request) to handle a request */
	app: Hono;
	/** The mounted billing service */
	svc: BillingService;
	/** Tear down the service and close the database */
	close(): Promise<void>;
}

/**
 * Wrap bun:sqlite so Kysely's SqliteDialect can detect reader vs writer
 * statements. bun:sqlite doesn't set `stmt.reader`, so SELECT queries
 * return empty results without this wrapper.
 */
export function wrapBunSqlite(inner: Database) {
	return new Proxy(inner, {
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
							const val = (stmtTarget as any)[stmtProp];
							if (typeof val === "function") return val.bind(stmtTarget);
							return val;
						},
					});
				};
			}
			const val = (target as any)[prop];
			if (typeof val === "function") return val.bind(target);
			return val;
		},
	});
}

/**
 * Creates a fully wired app instance.
 *
 * @param dbPath - SQLite database path. Defaults to ":memory:" for tests.
 */
export async function createApp(dbPath = ":memory:"): Promise<App> {
	const inner = new Database(dbPath);
	inner.exec("PRAGMA journal_mode = WAL");
	inner.exec("PRAGMA foreign_keys = ON");
	inner.exec(SQLITE_UP);

	const db = wrapBunSqlite(inner);

	const svc = billing({
		database: db,
		mount: "/api/billing",
		baseURL: "http://localhost",
	});

	await svc.init();

	const app = new Hono();

	app.get("/", (c) =>
		c.json({
			name: "host-hono",
			status: "ok",
			services: [svc.id],
		}),
	);

	app.all("/api/billing/*", (c) => svc.handler(c.req.raw));

	return {
		app,
		svc,
		async close() {
			await svc.shutdown();
			inner.close();
		},
	};
}
