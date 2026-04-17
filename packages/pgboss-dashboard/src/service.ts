import type { MountedService, ServiceConfig } from "futonic";
import { createDashboardProxy } from "./proxy";
import {
	type DashboardSubprocess,
	startDashboardSubprocess,
} from "./subprocess";

export interface PgBossDashboardConfig {
	/**
	 * Postgres connection string that `@pg-boss/dashboard` should use.
	 * Pipe-separated `Name=url|Name2=url2` is supported for multi-database setups.
	 */
	databaseURL: string;
	/**
	 * pg-boss schema name. Pipe-separated when pairing with multiple databases.
	 * Defaults to `pgboss`.
	 */
	schema?: string;
	/** Optional HTTP basic auth for the dashboard. */
	auth?: { username: string; password: string };
	/**
	 * Port for the internal subprocess to bind. If omitted, a random free port
	 * is chosen. The dashboard is only reachable via the service proxy —
	 * callers should bind to localhost only.
	 */
	subprocessPort?: number;
	/** Host interface the subprocess binds. Defaults to 127.0.0.1. */
	subprocessHost?: string;
	/**
	 * Override the resolved path to the @pg-boss/dashboard CLI. Useful for
	 * monorepos where the package lives outside standard node_modules lookup.
	 */
	binPath?: string;
	/** Pass-through for subprocess stdout/stderr. Defaults to "inherit". */
	stdio?: "inherit" | "pipe" | "ignore";
	/** Maximum startup wait for the subprocess. Defaults to 15_000 ms. */
	startupTimeoutMs?: number;
}

/**
 * A mounted pgboss-dashboard service, extended with a handle to the running
 * subprocess once `host.init()` has completed.
 */
export interface MountedPgBossDashboard
	extends MountedService<PgBossDashboardConfig> {
	/**
	 * The upstream subprocess handle. Populated after `host.init()`.
	 */
	subprocess?: DashboardSubprocess;
}

/**
 * Mounts @pg-boss/dashboard as a futonic service.
 *
 * On `host.init()`, the dashboard CLI is spawned as a child process bound to
 * a local port. On `host.shutdown()`, the subprocess is terminated.
 *
 * The service does not declare `database: true` because the dashboard opens
 * its own `pg` connections from the configured `databaseURL`; it does not
 * use futonic's shared Kysely instance.
 *
 * @example
 * ```ts
 * const dashboard = pgbossDashboard({
 *   mount: "/admin/queues",
 *   config: { databaseURL: process.env.DATABASE_URL! },
 * });
 * const host = createHost({ services: [dashboard] });
 * await host.init();
 *
 * const router = createPgBossDashboardRouter(dashboard);
 * app.all("/admin/queues/*", (c) => router.handler(c.req.raw));
 * ```
 */
export function pgbossDashboard(
	config: ServiceConfig<PgBossDashboardConfig>,
): MountedPgBossDashboard {
	// Build a fresh MountedService per mount call so each instance has its
	// own lifecycle closures over its subprocess handle.
	const service: MountedPgBossDashboard = {
		id: "pgboss-dashboard",
		version: "0.1.0",
		dependencies: { database: false },
		endpoints: {},
		mountConfig: config,

		async onInit(ctx) {
			const cfg = config.config;
			if (!cfg?.databaseURL) {
				throw new Error(
					'pgboss-dashboard requires `config.databaseURL`. Pass it when mounting: pgbossDashboard({ mount: "/admin", config: { databaseURL } })',
				);
			}

			service.subprocess = await startDashboardSubprocess({
				databaseURL: cfg.databaseURL,
				schema: cfg.schema,
				auth: cfg.auth,
				port: cfg.subprocessPort,
				host: cfg.subprocessHost,
				binPath: cfg.binPath,
				stdio: cfg.stdio,
				startupTimeoutMs: cfg.startupTimeoutMs,
				logger: ctx.logger,
			});

			ctx.logger.info(
				`pgboss-dashboard proxying ${ctx.hostInfo.mountPath} → ${service.subprocess.origin}`,
			);
		},

		async onShutdown() {
			if (service.subprocess) {
				await service.subprocess.stop();
				service.subprocess = undefined;
			}
		},
	};

	return service;
}

export interface PgBossDashboardRouter {
	/** Forward a Request to the upstream dashboard and return its Response. */
	handler(request: Request): Promise<Response>;
	/**
	 * Force-stop the subprocess. Normally redundant because `host.shutdown()`
	 * already tears it down, but useful for tests that bypass the host.
	 */
	stop(): Promise<void>;
}

/**
 * Builds an HTTP handler that forwards requests to the dashboard subprocess.
 * Call after `host.init()` once the service has started.
 */
export function createPgBossDashboardRouter(
	service: MountedPgBossDashboard,
): PgBossDashboardRouter {
	const ctx = service.serviceContext;
	if (!ctx) {
		throw new Error(
			"pgboss-dashboard service has no serviceContext — did you forget to call host.init()?",
		);
	}
	if (!service.subprocess) {
		throw new Error(
			"pgboss-dashboard subprocess has not been started. Ensure `host.init()` completed before mounting the router.",
		);
	}

	const subprocess = service.subprocess;
	const proxy = createDashboardProxy({
		upstreamOrigin: subprocess.origin,
		mountPath: ctx.hostInfo.mountPath,
	});

	return {
		handler: proxy,
		stop: () => subprocess.stop(),
	};
}
