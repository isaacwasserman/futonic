import type { Router } from "better-call";
import type { Context, Hono } from "hono";

/**
 * Mounts a better-call router into a Hono app as a catch-all sub-route.
 *
 * The router's `handler` already takes a Web Request and returns a Response,
 * which maps directly to Hono's Web-standard Request/Response model.
 *
 * Usage:
 * ```ts
 * import { Hono } from "hono";
 * import { mountRouter } from "futonic/hono";
 *
 * const app = new Hono();
 * mountRouter(app, "/api/billing/*", billingRouter);
 * ```
 */
export function mountRouter(app: Hono, path: string, router: Router) {
	app.all(path, async (c: Context) => {
		return router.handler(c.req.raw);
	});
}

/**
 * Creates a Hono fetch handler from a better-call router.
 *
 * Useful when you want to handle a sub-path yourself:
 * ```ts
 * import { toHonoHandler } from "futonic/hono";
 *
 * app.all("/api/billing/*", toHonoHandler(billingRouter));
 * ```
 */
export function toHonoHandler(router: Router) {
	return async (c: Context) => {
		return router.handler(c.req.raw);
	};
}
