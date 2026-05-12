import { APIError, createMiddleware } from "better-call";
import type { ServiceContext } from "futonic";
import type { SupportSchema } from "./schema";

export type SupportRole = "customer" | "admin";

export interface SupportUser {
	id: string;
	role: SupportRole;
}

/**
 * Host-supplied identification function.
 *
 * The host knows how it authenticates requests (sessions, JWT, API keys, ...).
 * It passes this function via the service's mount config; the service calls it
 * for every request and trusts the result. Returning null signals "no user"
 * which becomes a 401.
 */
export type IdentifyUser = (
	headers: Headers,
) => SupportUser | null | Promise<SupportUser | null>;

export interface SupportConfig {
	identifyUser: IdentifyUser;
}

/**
 * Reads identifyUser from the service config, invokes it with the request
 * headers, and attaches the resulting user to ctx.context.auth.
 * Short-circuits with 401 if no user is identified.
 */
export function createAuthMiddleware(
	serviceCtx: ServiceContext<SupportSchema>,
) {
	const identify = (serviceCtx.config as { identifyUser?: IdentifyUser })
		.identifyUser;

	return createMiddleware(async (ctx) => {
		if (typeof identify !== "function") {
			throw new APIError("INTERNAL_SERVER_ERROR", {
				message: "support service misconfigured: identifyUser missing",
			});
		}

		const request = (ctx as { request?: Request }).request;
		if (!request) {
			throw new APIError("UNAUTHORIZED", { message: "Unauthenticated" });
		}

		const user = await identify(request.headers);
		if (!user) {
			throw new APIError("UNAUTHORIZED", { message: "Unauthenticated" });
		}

		return { auth: user };
	});
}

/**
 * Composes after the auth middleware. Rejects non-admin callers with 403.
 */
export function createAdminMiddleware() {
	return createMiddleware(async (ctx) => {
		const auth = (ctx as { context?: { auth?: SupportUser } }).context?.auth;
		if (!auth || auth.role !== "admin") {
			throw new APIError("FORBIDDEN", { message: "Forbidden" });
		}
		return {};
	});
}
