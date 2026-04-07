import { createEndpoint, type EndpointOptions } from "better-call";
import { createServiceMiddleware } from "./middleware";
import type { ServiceContext } from "../core/context";

/**
 * Creates a service endpoint that automatically injects the ServiceContext
 * middleware. Wraps better-call's `createEndpoint`.
 */
export function createServiceEndpoint<TResponse>(
	path: string,
	options: EndpointOptions & { serviceCtx?: ServiceContext },
	handler: (ctx: { context: { serviceCtx: ServiceContext }; query: Record<string, unknown>; body: unknown; params: Record<string, string>; headers: Headers }) => Promise<TResponse>,
) {
	// If serviceCtx is provided at definition time, inject it.
	// Otherwise, it must be injected at mount time via the host.
	const middlewares = [...(options.use ?? [])];

	if (options.serviceCtx) {
		middlewares.unshift(createServiceMiddleware(options.serviceCtx));
	}

	const { serviceCtx: _, ...restOptions } = options;

	return createEndpoint(path, {
		...restOptions,
		use: middlewares,
	}, handler as never);
}
