/**
 * Test harness for the support service.
 *
 * Builds a self-contained in-memory SQLite database, a futonic host with the
 * support service mounted, and a better-call router — without pulling in any
 * HTTP framework. Each test that calls `createSupportTestApp()` gets an
 * isolated DB, so there are no ordering dependencies.
 */

import { Database } from "bun:sqlite";
import { type Host, createHost } from "futonic";
import type { IdentifyUser, SupportUser } from "./auth";
import { createSupportRouter, support } from "./index";
import { SQLITE_UP } from "./migrations";

/**
 * Adds `stmt.reader` so Kysely's SqliteDialect distinguishes SELECTs from
 * writes under bun:sqlite. Same approach as futonic's internal test-utils.
 */
function wrapBunSqlite(inner: Database) {
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

export interface SupportTestApp {
	host: Host;
	fetch(request: Request): Promise<Response>;
	close(): Promise<void>;
}

export async function createSupportTestApp(opts?: {
	identifyUser?: IdentifyUser;
}): Promise<SupportTestApp> {
	const inner = new Database(":memory:");
	inner.exec("PRAGMA foreign_keys = ON");
	inner.exec(SQLITE_UP);
	const db = wrapBunSqlite(inner);

	const identifyUser: IdentifyUser =
		opts?.identifyUser ??
		((headers) => {
			const id = headers.get("x-user-id");
			const role = headers.get("x-user-role");
			if (!id || (role !== "customer" && role !== "admin")) return null;
			return { id, role } satisfies SupportUser;
		});

	const mounted = support({
		mount: "/api/support",
		config: { identifyUser },
	});

	const host = createHost({
		database: db,
		baseURL: "http://localhost",
		// Cast: futonic's MountedService generic variance loses the concrete
		// schema once an array of services with mixed schemas is constructed.
		// The same workaround appears in examples/host-hono/src/app.ts.
		services: [mounted as any],
	});
	await host.init();

	const router = createSupportRouter("/api/support", mounted.serviceContext!);

	return {
		host,
		fetch: (request: Request) => router.handler(request),
		async close() {
			await host.shutdown();
			inner.close();
		},
	};
}

export function req(path: string, init?: RequestInit) {
	return new Request(`http://localhost${path}`, init);
}

export function asUser(id: string, role: "customer" | "admin") {
	return { "x-user-id": id, "x-user-role": role };
}

export function json(body: unknown, headers: Record<string, string> = {}) {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	} satisfies RequestInit;
}

/** Untyped JSON body — keeps test assertions readable. */
export async function readJson(res: Response): Promise<any> {
	return res.json();
}
