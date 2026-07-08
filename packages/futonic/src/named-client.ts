/**
 * A name-keyed client wrapper over better-call's path-keyed client.
 *
 * better-call's `createClient` is invoked by method+path, e.g.
 * `client("@post/tickets", { body })`. This wraps it so endpoints can be called
 * by their record key instead: `client.createTicket({ body })`. Types are
 * derived from the endpoints, so each method's input and response stay inferred.
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

/** Computes the better-call path key for an endpoint (GET is bare, others `@method`). */
function routeKey(method: string, path: string): string {
	return method.toUpperCase() === "GET"
		? path
		: `@${method.toLowerCase()}${path}`;
}

/**
 * Wraps better-call's path-keyed client so endpoints can be called by name:
 *
 * ```ts
 * const client = createNamedClient(service.endpoints, { baseURL });
 * const res = await client.createTicket({ body: { title, summary } });
 * ```
 */
export function createNamedClient<TEndpoints extends Record<string, Endpoint>>(
	endpoints: TEndpoints,
	options?: ClientOptions,
): NamedClient<TEndpoints> {
	const base = createClient<TEndpoints>(options);
	const client: Record<string, (opts?: unknown) => unknown> = {};

	for (const [name, endpoint] of Object.entries(endpoints)) {
		const rawMethod = endpoint.options.method;
		const method = Array.isArray(rawMethod) ? rawMethod[0] : String(rawMethod);
		const key = routeKey(method, endpoint.path);
		client[name] = (opts?: unknown) =>
			(base as (path: string, opts?: unknown) => unknown)(key, opts);
	}

	return client as NamedClient<TEndpoints>;
}
