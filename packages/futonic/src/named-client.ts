/**
 * A name-keyed client wrapper over better-call's path-keyed client.
 *
 * better-call's `createClient` is invoked by method+path, e.g.
 * `client("@post/tickets", { body })`. This wraps it so endpoints can be called
 * by their record key instead: `client.createTicket({ body })`. Types are
 * derived from the endpoints, so each method's input and response stay inferred.
 *
 * The client is driven by a plain, serializable route manifest rather than the
 * live endpoints object, so it can be built in the browser without importing
 * any server code. In-process, derive the manifest with `toNamedClientRoutes`;
 * for the browser, codegen a static manifest module (see `codegen.ts`) so the
 * browser gets only that data plus the endpoint types (via `import type`).
 */

import type {
	BetterFetchOption,
	BetterFetchResponse,
} from "@better-fetch/fetch";
import type { Endpoint } from "better-call";
import { type ClientOptions, createClient } from "better-call/client";

/** Extracts `:param` segments of a path into `{ param: string }`. */
type PathParams<Path extends string> =
	Path extends `${string}:${infer Param}/${infer Rest}`
		? { [K in Param]: string } & PathParams<`/${Rest}`>
		: Path extends `${string}:${infer Param}`
			? { [K in Param]: string }
			: // biome-ignore lint/complexity/noBannedTypes: "no params" is the empty object
				{};

/** `BetterFetchOption`'s query generic must be a record; coerce non-records. */
type SafeQuery<Q> = [Q] extends [Record<string, unknown>]
	? Q
	: Record<string, never>;

/** True when the endpoint declares a body with fields. */
type HasBody<Body> = [keyof Body] extends [never] ? false : true;

/** The call signature for a single endpoint, keyed by its record name. */
type NamedCall<E extends Endpoint> = E extends Endpoint<
	infer Path,
	// biome-ignore lint/suspicious/noExplicitAny: method not needed here
	any,
	infer Body,
	infer Query,
	// biome-ignore lint/suspicious/noExplicitAny: middleware not needed here
	any,
	infer R
>
	? HasBody<Body> extends true
		? (
				options: BetterFetchOption<Body, SafeQuery<Query>, PathParams<Path>> & {
					body: Body;
				},
			) => Promise<BetterFetchResponse<Awaited<R>>>
		: (
				options?: BetterFetchOption<Body, SafeQuery<Query>, PathParams<Path>>,
			) => Promise<BetterFetchResponse<Awaited<R>>>
	: never;

/** The name-keyed client: one method per endpoint record key. */
export type NamedClient<TEndpoints extends Record<string, Endpoint>> = {
	[K in keyof TEndpoints]: NamedCall<TEndpoints[K]>;
};

/** A single endpoint's routing info — the only runtime data the client needs. */
export type NamedRoute = { method: string; path: string };

declare const ENDPOINTS: unique symbol;

/**
 * A serializable route manifest keyed by endpoint record name. Plain data
 * (no handlers, schemas, or db references), so it is safe to ship to the
 * browser. The phantom `TEndpoints` brand lets `createClientFromManifest` recover the
 * endpoint types for inference.
 */
export type NamedClientRoutes<TEndpoints extends Record<string, Endpoint>> = {
	[K in keyof TEndpoints]: NamedRoute;
} & { readonly [ENDPOINTS]?: TEndpoints };

/** Computes the better-call path key for an endpoint (GET is bare, others `@method`). */
function routeKey(method: string, path: string): string {
	return method.toUpperCase() === "GET"
		? path
		: `@${method.toLowerCase()}${path}`;
}

/**
 * Extracts a serializable route manifest from a live endpoints record. Runs
 * wherever the endpoints are available (server or shared code); the result is
 * plain data safe to pass to `createClientFromManifest` in the browser.
 */
export function toNamedClientRoutes<
	TEndpoints extends Record<string, Endpoint>,
>(endpoints: TEndpoints): NamedClientRoutes<TEndpoints> {
	const routes: Record<string, NamedRoute> = {};

	for (const [name, endpoint] of Object.entries(endpoints)) {
		const rawMethod = endpoint.options.method;
		const method = Array.isArray(rawMethod) ? rawMethod[0] : String(rawMethod);
		routes[name] = { method, path: endpoint.path };
	}

	return routes as NamedClientRoutes<TEndpoints>;
}

/**
 * Wraps better-call's path-keyed client so endpoints can be called by name.
 * Takes only a serializable route manifest and options — never the live
 * endpoints — so it is safe to build in the browser:
 *
 * ```ts
 * import { createClientFromManifest } from "futonic/client";
 * import type { ticketingService } from "@acme/ticketing";
 *
 * const client = createClientFromManifest<typeof ticketingService.endpoints>(routes, {
 *   baseURL: "/api/ticketing",
 * });
 * const res = await client.createTicket({ body: { title, summary } });
 * ```
 */
export function createClientFromManifest<
	TEndpoints extends Record<string, Endpoint>,
>(
	routes: NamedClientRoutes<TEndpoints>,
	options?: ClientOptions,
): NamedClient<TEndpoints> {
	const base = createClient<TEndpoints>(options);
	const client: Record<string, (opts?: unknown) => unknown> = {};

	for (const [name, route] of Object.entries(
		routes as Record<string, NamedRoute>,
	)) {
		const key = routeKey(route.method, route.path);
		client[name] = (opts?: unknown) =>
			(base as (path: string, opts?: unknown) => unknown)(key, opts);
	}

	return client as NamedClient<TEndpoints>;
}
