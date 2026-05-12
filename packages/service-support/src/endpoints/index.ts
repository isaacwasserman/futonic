import type { Middleware } from "better-call";
import { createAdminEndpoints } from "./admin";
import { createCustomerEndpoints } from "./customer";

export interface SupportMiddlewares {
	serviceMw: Middleware;
	authMw: Middleware;
	adminMw: Middleware;
}

/**
 * Builds the full endpoint map. Customer endpoints run through
 * [serviceMw, authMw]; admin endpoints add adminMw on top.
 */
export function createSupportEndpoints(mw: SupportMiddlewares) {
	const customer = createCustomerEndpoints([mw.serviceMw, mw.authMw]);
	const admin = createAdminEndpoints([mw.serviceMw, mw.authMw, mw.adminMw]);
	return { ...customer, ...admin };
}
