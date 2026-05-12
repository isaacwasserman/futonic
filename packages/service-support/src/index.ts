/**
 * service-support — customer support ticket service for futonic.
 *
 * Forum-like API with two role-based flows:
 *   - Customers open tickets, post replies, and close their own tickets.
 *   - Admins triage, comment on, and update any ticket.
 *
 * Authentication is delegated to the host: the mount config requires an
 * `identifyUser(headers) => SupportUser | null` function that the service
 * calls on every request.
 */

import { createRouter } from "better-call";
import {
	type ServiceContext,
	createService,
	createServiceMiddleware,
} from "futonic";
import {
	type SupportConfig,
	createAdminMiddleware,
	createAuthMiddleware,
} from "./auth";
import { createSupportEndpoints } from "./endpoints";
import { type SupportSchema, supportSchema } from "./schema";

export const support = createService<
	SupportConfig,
	SupportSchema,
	Record<string, never>
>({
	id: "support",
	version: "0.1.0",
	dependencies: { database: true },
	dbSchema: supportSchema,
	endpoints: {},

	async onInit(ctx) {
		ctx.logger.info("Support service initialized");
	},

	async onReady(ctx) {
		ctx.logger.info("Support service ready");
	},

	async onShutdown() {
		console.log("[support] Shutting down");
	},
});

export function createSupportRouter(
	mountPath: string,
	serviceContext: ServiceContext<SupportSchema>,
) {
	const serviceMw = createServiceMiddleware(serviceContext);
	const authMw = createAuthMiddleware(serviceContext);
	const adminMw = createAdminMiddleware();
	const endpoints = createSupportEndpoints({ serviceMw, authMw, adminMw });
	return createRouter(endpoints, { basePath: mountPath });
}

export { supportSchema } from "./schema";
export type { SupportSchema } from "./schema";
export type {
	SupportConfig,
	SupportUser,
	SupportRole,
	IdentifyUser,
} from "./auth";
