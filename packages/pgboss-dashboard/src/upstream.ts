import type { Hono } from "hono";

export interface DashboardEnv {
	/**
	 * Postgres connection string the dashboard should use.
	 * Supports pipe-separated `Name=url|Name2=url2` for multi-database setups.
	 */
	databaseURL: string;
	/**
	 * pg-boss schema name. Pipe-separated when pairing with multiple databases.
	 * Defaults to `pgboss`.
	 */
	schema?: string;
	/** Optional HTTP basic auth for the dashboard. */
	auth?: { username: string; password: string };
}

/**
 * Applies environment variables the upstream dashboard build reads at
 * module-evaluation time. Must be called before the dynamic import below.
 */
function applyDashboardEnv(env: DashboardEnv): void {
	process.env.DATABASE_URL = env.databaseURL;
	process.env.PGBOSS_SCHEMA = env.schema ?? "pgboss";
	if (env.auth) {
		process.env.PGBOSS_DASHBOARD_AUTH_USERNAME = env.auth.username;
		process.env.PGBOSS_DASHBOARD_AUTH_PASSWORD = env.auth.password;
	} else {
		// Assigning `undefined` to process.env coerces to the string
		// "undefined", which would falsely enable basic auth. Reflect-based
		// deletion is equivalent to `delete` without tripping biome's rule.
		Reflect.deleteProperty(process.env, "PGBOSS_DASHBOARD_AUTH_USERNAME");
		Reflect.deleteProperty(process.env, "PGBOSS_DASHBOARD_AUTH_PASSWORD");
	}
	// The upstream build calls serve() with PORT/HOST. We pin it to port 0
	// on loopback so the stray TCP listener gets an ephemeral port that we
	// close below. Only set these if the host app hasn't pinned its own.
	if (!process.env.PORT) process.env.PORT = "0";
	if (!process.env.HOST) process.env.HOST = "127.0.0.1";
}

/**
 * Closes the stray `net.Server` the upstream build opens via `serve()` inside
 * `react-router-hono-server`. The Hono app itself works fine without a native
 * listener — we just call `app.fetch(request)` directly — but the side-effect
 * listener needs to be reaped so it doesn't leak a file descriptor.
 *
 * Uses `process._getActiveHandles()` because the dashboard's built bundle
 * does not expose the server handle through any option. The API is
 * undocumented but has shipped in every Node release since 0.10.
 */
function closeStrayListeners(
	before: Set<unknown>,
	logger: {
		warn: (msg: string, ...args: unknown[]) => void;
	},
): number {
	const getHandles = (
		process as unknown as { _getActiveHandles?: () => unknown[] }
	)._getActiveHandles;
	if (typeof getHandles !== "function") {
		logger.warn(
			"Cannot enumerate process handles — the stray HTTP listener created by @pg-boss/dashboard will remain open until process exit.",
		);
		return 0;
	}

	let closed = 0;
	for (const handle of getHandles.call(process)) {
		if (before.has(handle)) continue;
		const maybeServer = handle as {
			close?: (cb?: () => void) => void;
			unref?: () => void;
			address?: () => unknown;
		};
		// net.Server exposes both `close` and `address()`. That's specific
		// enough to distinguish it from timers, sockets, and pipes.
		if (
			typeof maybeServer.close === "function" &&
			typeof maybeServer.address === "function"
		) {
			try {
				maybeServer.close();
				maybeServer.unref?.();
				closed++;
			} catch {
				// Best-effort: if close throws, unref at least prevents it
				// from keeping the event loop alive.
				maybeServer.unref?.();
			}
		}
	}
	return closed;
}

function snapshotHandles(): Set<unknown> {
	const getHandles = (
		process as unknown as { _getActiveHandles?: () => unknown[] }
	)._getActiveHandles;
	return new Set(
		typeof getHandles === "function" ? getHandles.call(process) : [],
	);
}

export interface LoadedDashboard {
	/** The upstream Hono app. Use `app.fetch(request)` to handle a request. */
	app: Hono;
}

/**
 * Loads `@pg-boss/dashboard` in-process.
 *
 * The upstream package is a React Router 7 + Hono SSR app whose build auto-
 * calls `@hono/node-server`'s `serve()` on import. We let it bind to an
 * ephemeral loopback port, then immediately close the stray listener — what
 * we actually want is the Hono app instance, which `createHonoServer` also
 * returns. Callers use `app.fetch(request)` to handle requests, bypassing
 * the listener entirely.
 */
export async function loadDashboard(
	env: DashboardEnv,
	logger: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
	},
): Promise<LoadedDashboard> {
	applyDashboardEnv(env);

	const before = snapshotHandles();

	// Dynamic import so env vars above are visible when the upstream module
	// evaluates.
	const mod = (await import("@pg-boss/dashboard/build/server/index.js")) as {
		default: Promise<Hono> | Hono;
	};

	const app = await mod.default;

	const closed = closeStrayListeners(before, logger);
	if (closed > 0) {
		logger.info(
			`Closed ${closed} stray HTTP listener(s) from @pg-boss/dashboard; routing via app.fetch()`,
		);
	}

	return { app };
}
