import { createMiddleware } from "better-call";
import type { ServiceContext } from "../core/context";

/**
 * Creates a better-call middleware that injects the ServiceContext
 * onto `ctx.context.serviceCtx`, identical to how better-auth
 * injects AuthContext.
 */
export function createServiceMiddleware(serviceCtx: ServiceContext) {
	return createMiddleware(async () => {
		return { serviceCtx };
	});
}
