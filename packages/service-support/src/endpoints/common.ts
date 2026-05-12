import type { ServiceContext } from "futonic";
import type { SupportUser } from "../auth";
import type { SupportSchema } from "../schema";

/**
 * Endpoint handlers receive the better-call context. After our middlewares
 * run, `ctx.context` contains the serviceCtx and the identified user.
 */
export type SupportEndpointCtx = {
	context: {
		serviceCtx: ServiceContext<SupportSchema>;
		auth: SupportUser;
	};
};

export function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function nowIso(): string {
	return new Date().toISOString();
}
