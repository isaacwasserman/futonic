import type { MountedService, ServiceConfig } from "futonic";
import type { Hono } from "hono";
import { type DashboardEnv, loadDashboard } from "./upstream";

export interface PgBossDashboardConfig extends DashboardEnv {}

/**
 * A mounted pgboss-dashboard service, extended with the loaded Hono app
 * once `host.init()` has completed.
 */
export interface MountedPgBossDashboard
	extends MountedService<PgBossDashboardConfig> {
	/** The upstream Hono app. Populated after `host.init()`. */
	app?: Hono;
}

/**
 * Mounts `@pg-boss/dashboard` as a futonic service.
 *
 * The upstream package exposes its server only as a side-effecting build that
 * auto-listens on a TCP port; this wrapper imports the build in-process,
 * pulls out the underlying Hono app, and closes the stray listener. The host
 * mounts the service via `createPgBossDashboardRouter`, which forwards
 * requests to `app.fetch` with no subprocess and no proxy hop.
 *
 * The service does not declare `database: true` because the dashboard opens
 * its own `pg` pool from the configured `databaseURL`; it does not use
 * futonic's shared Kysely instance.
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

			const loaded = await loadDashboard(cfg, ctx.logger);
			service.app = loaded.app;

			ctx.logger.info(`pgboss-dashboard mounted at ${ctx.hostInfo.mountPath}`);
		},

		async onShutdown() {
			// Nothing to close — the stray listener was reaped at init time
			// and the Hono app holds no external resources of its own.
			// (pg-boss opens Pools per-request inside the dashboard's
			// loaders, which tear down with the request lifecycle.)
			service.app = undefined;
		},
	};

	return service;
}

export interface PgBossDashboardRouter {
	/**
	 * Forward a Request to the embedded dashboard's Hono app and return its
	 * Response. The request path is passed through unchanged — the upstream
	 * dashboard uses `basename: "/"`, so it expects the path portion after
	 * your mount prefix to start at `/`.
	 */
	handler(request: Request): Promise<Response>;
}

/**
 * Strips the service's mount prefix off an incoming request URL. The upstream
 * dashboard routes everything against `/`, so we need to rewrite `/admin/queues/jobs`
 * to `/jobs` before handing it to `app.fetch`.
 */
function stripMountPath(requestUrl: string, mountPath: string): string {
	let mount = mountPath;
	if (!mount.startsWith("/")) mount = `/${mount}`;
	if (mount.length > 1 && mount.endsWith("/")) mount = mount.slice(0, -1);

	const url = new URL(requestUrl);
	if (url.pathname === mount) {
		url.pathname = "/";
	} else if (url.pathname.startsWith(`${mount}/`)) {
		url.pathname = url.pathname.slice(mount.length);
	}
	return url.toString();
}

/**
 * Builds a request handler that forwards to the embedded dashboard. Call
 * after `host.init()` once the upstream has loaded.
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
	if (!service.app) {
		throw new Error(
			"pgboss-dashboard has not been initialised. Ensure `host.init()` completed before mounting the router.",
		);
	}

	const app = service.app;
	const mountPath = ctx.hostInfo.mountPath;

	return {
		async handler(request) {
			const rewritten = stripMountPath(request.url, mountPath);
			const innerRequest =
				rewritten === request.url ? request : new Request(rewritten, request);
			return app.fetch(innerRequest);
		},
	};
}
