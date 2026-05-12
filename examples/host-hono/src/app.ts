/**
 * App factory — creates the Hono app, database, and futonic host.
 *
 * Separated from index.ts so e2e tests can spin up isolated instances
 * with in-memory SQLite without starting a real TCP server.
 */

import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { createHost, type Host } from "futonic";
import { billing, createBillingRouter } from "service-billing";
import { SQLITE_UP } from "service-billing/src/migrations";
import {
	support,
	createSupportRouter,
	type SupportUser,
} from "service-support";
import { SQLITE_UP as SUPPORT_SQL } from "service-support/src/migrations";

export interface App {
	/** Hono app — call app.fetch(request) to handle a request */
	app: Hono;
	/** Futonic host — manages service lifecycle */
	host: Host;
	/** Tear down the host and close the database */
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
							if (stmtProp === "reader")
								return isReader || hasReturning;
							const val = (stmtTarget as any)[stmtProp];
							if (typeof val === "function")
								return val.bind(stmtTarget);
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
	inner.exec(SUPPORT_SQL);

	const db = wrapBunSqlite(inner);

	const mounted = billing({ mount: "/api/billing" });

	// The support service delegates user identification back to the host.
	// This stub reads x-user-id and x-user-role headers; a real host would
	// pull from its existing session/JWT layer.
	const mountedSupport = support({
		mount: "/api/support",
		config: {
			identifyUser: (headers) => {
				const id = headers.get("x-user-id");
				const role = headers.get("x-user-role");
				if (!id || (role !== "customer" && role !== "admin")) return null;
				return { id, role } satisfies SupportUser;
			},
		},
	});

	const host = createHost({
		database: db,
		baseURL: "http://localhost",
		services: [mounted, mountedSupport],
	});

	await host.init();

	const billingRouter = createBillingRouter(
		"/api/billing",
		mounted.serviceContext!,
	);

	const supportRouter = createSupportRouter(
		"/api/support",
		mountedSupport.serviceContext!,
	);

	const app = new Hono();

	app.get("/", (c) =>
		c.json({
			name: "host-hono",
			status: "ok",
			services: Array.from(host.services.keys()),
		}),
	);

	app.all("/api/billing/*", (c) => billingRouter.handler(c.req.raw));
	app.all("/api/support/*", (c) => supportRouter.handler(c.req.raw));

	return {
		app,
		host,
		async close() {
			await host.shutdown();
			inner.close();
		},
	};
}
