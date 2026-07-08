/**
 * Client-only entry point (`futonic/client`). Re-exports better-call's typesafe
 * client and the name-keyed client so consumers can build one without pulling
 * in any server code:
 *
 * ```ts
 * import { createClient } from "futonic/client";
 * import type { ticketingService } from "@acme/ticketing";
 *
 * const client = createClient<typeof ticketingService.router>({
 *   baseURL: "/api/ticketing",
 * });
 * ```
 */
export { createClient } from "better-call/client";
export {
	createNamedClient,
	type NamedClient,
	type NamedClientRoutes,
	type NamedRoute,
	toNamedClientRoutes,
} from "./named-client";
