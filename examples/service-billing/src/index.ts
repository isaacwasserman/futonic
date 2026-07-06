/**
 * service-billing — an example futonic tenant service.
 *
 * This is what a service author publishes as an npm package. Host applications
 * install it and run it directly — they never import "futonic" themselves:
 *
 * ```ts
 * const svc = billing({ database, mount: "/api/billing" });
 * await svc.init();
 * app.all("/api/billing/*", (c) => svc.handler(c.req.raw));
 * ```
 */

import { createService } from "futonic";
import { createBillingEndpoints } from "./endpoints";
import { billingSchema } from "./schema";

export const billing = createService({
	id: "billing",
	version: "0.1.0",
	dbSchema: billingSchema,
	endpoints: createBillingEndpoints,

	async onInit(ctx) {
		ctx.logger.info("Billing service ready");
	},

	async onShutdown() {
		console.log("[billing] Shutting down");
	},
});

// Re-export schema for host applications that want to generate migrations
export { billingSchema } from "./schema";
export type { BillingSchema } from "./schema";
