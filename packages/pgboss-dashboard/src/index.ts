/**
 * futonic-pgboss-dashboard — embed @pg-boss/dashboard into a host application
 * as a futonic service.
 *
 * The upstream @pg-boss/dashboard package ships as a standalone Hono server
 * with no programmatic export, so this wrapper runs it as a child process
 * bound to a local port and reverse-proxies requests through a futonic
 * service endpoint. The host application gets a single mount point to wire
 * into its router — no extra container, no extra deployment.
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

export { createDashboardProxy } from "./proxy";
export type { ProxyOptions } from "./proxy";

export {
	startDashboardSubprocess,
	findFreePort,
} from "./subprocess";
export type {
	SubprocessOptions,
	DashboardSubprocess,
} from "./subprocess";
