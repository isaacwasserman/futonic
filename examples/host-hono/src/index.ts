/**
 * host-hono — example futonic host application.
 *
 * Demonstrates a realistic setup:
 * 1. Create a Hono server
 * 2. Set up a SQLite database (bun:sqlite)
 * 3. Mount the billing tenant service via futonic
 * 4. Wire the service's router into Hono
 */

import { Hono } from "hono";
import { logger } from "hono/logger";
import { Database } from "bun:sqlite";
import { createHost } from "futonic";
import { billing, createBillingRouter } from "service-billing";
import { SQLITE_UP } from "service-billing/src/migrations";

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const inner = new Database("host.db");
inner.exec("PRAGMA journal_mode = WAL");
inner.exec("PRAGMA foreign_keys = ON");

// Run service migrations (in prod you'd use a proper migration tool)
inner.exec(SQLITE_UP);

/**
 * Wrap bun:sqlite so Kysely's SqliteDialect can detect reader vs writer
 * statements. bun:sqlite doesn't set `stmt.reader`, so SELECT queries
 * return empty results without this wrapper.
 */
const db = new Proxy(inner, {
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

// ---------------------------------------------------------------------------
// Mount services via futonic
// ---------------------------------------------------------------------------

const mounted = billing({ mount: "/api/billing" });

const host = createHost({
	database: db,
	baseURL: "http://localhost:3000",
	services: [mounted],
});

await host.init();

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

app.use("*", logger());

// Health check
app.get("/", (c) => {
	return c.json({
		name: "host-hono",
		status: "ok",
		services: Array.from(host.services.keys()),
	});
});

// Mount the billing service router — router.handler uses standard Request/Response
const billingRouter = createBillingRouter(
	"/api/billing",
	mounted.serviceContext!,
);
app.all("/api/billing/*", (c) => billingRouter.handler(c.req.raw));

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 3000;

console.log(`\n  host-hono listening on http://localhost:${port}`);
console.log(`  Mounted services: ${Array.from(host.services.keys()).join(", ")}\n`);

const server = Bun.serve({
	port,
	fetch: app.fetch,
});

// Graceful shutdown
process.on("SIGINT", async () => {
	console.log("\nShutting down...");
	await host.shutdown();
	inner.close();
	server.stop();
	process.exit(0);
});
