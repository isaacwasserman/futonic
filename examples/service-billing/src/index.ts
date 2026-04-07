/**
 * service-billing — an example futonic tenant service.
 *
 * This is what a service author publishes as an npm package.
 * Host applications install it and mount it via `createHost()`.
 */

import { createService, createServiceMiddleware } from "futonic";
import { createRouter } from "better-call";
import { billingSchema } from "./schema";
import { createBillingEndpoints } from "./endpoints";

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

export const billing = createService({
	id: "billing",
	version: "0.1.0",
	dependencies: { database: true },
	dbSchema: billingSchema,
	endpoints: {},

	async onInit(ctx) {
		ctx.logger.info("Billing service initialized");
	},

	async onReady(ctx) {
		ctx.logger.info("Billing service ready");
	},

	async onShutdown() {
		console.log("[billing] Shutting down");
	},
});

// ---------------------------------------------------------------------------
// Router factory — creates a better-call router wired to a ServiceContext.
//
// The host calls this after init to get a router it can mount into its
// HTTP framework (Hono, Express, Next.js, etc.).
// ---------------------------------------------------------------------------

export function createBillingRouter(mountPath: string, serviceContext: unknown) {
	const middleware = createServiceMiddleware(serviceContext as any);
	const endpoints = createBillingEndpoints([middleware]);
	return createRouter(endpoints, { basePath: mountPath });
}

// Re-export schema for host applications that want to generate migrations
export { billingSchema } from "./schema";
export type { BillingSchema } from "./schema";
