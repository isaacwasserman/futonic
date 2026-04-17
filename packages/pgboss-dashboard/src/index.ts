/**
 * futonic-pgboss-dashboard — embed @pg-boss/dashboard into a host application
 * as a futonic service.
 *
 * The upstream @pg-boss/dashboard ships as a React Router 7 + Hono SSR app
 * whose build auto-binds a TCP listener on import. This wrapper imports the
 * build in-process, pulls out the underlying Hono app, reaps the stray
 * listener, and exposes `app.fetch` as the service's request handler.
 *
 * The host application gets a single mount point — no subprocess, no proxy
 * hop, no extra container.
 */

export {
	pgbossDashboard,
	createPgBossDashboardRouter,
} from "./service";
export type {
	PgBossDashboardConfig,
	MountedPgBossDashboard,
	PgBossDashboardRouter,
} from "./service";

export { loadDashboard } from "./upstream";
export type { DashboardEnv, LoadedDashboard } from "./upstream";
