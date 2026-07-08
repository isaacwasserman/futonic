/**
 * Build-time codegen for a static, browser-safe named client.
 *
 * A downstream service package runs this to emit a plain-data module holding
 * its route manifest, branded with the endpoint types. The emitted module
 * imports only types from server code (erased at build), so a browser can build
 * a fully-typed client without pulling in handlers, schemas, or the db layer.
 */

import { type Endpoint, createEndpoint } from "better-call";
import {
	type NamedClientRoutes,
	type NamedRoute,
	toNamedClientRoutes,
} from "./named-client";

/** The endpoints factory shape, loosened so any concrete definition matches. */
// biome-ignore lint/suspicious/noExplicitAny: the factory's argument type is irrelevant to route extraction
type EndpointsFactory = (defineEndpoint: any) => Record<string, Endpoint>;

/** A definition (or its constructor's `.definition`) that carries endpoints. */
export type WithEndpoints<F extends EndpointsFactory = EndpointsFactory> = {
	endpoints: F;
};

/**
 * Extracts the route manifest from an endpoints factory without constructing
 * the service. Endpoints are built with a no-op `defineEndpoint` (no service
 * middleware, no db) purely to read their static `path`/`method`; handlers are
 * never invoked, so no config or database connection is required.
 */
export function extractClientRoutes<F extends EndpointsFactory>(
	definition: WithEndpoints<F>,
): NamedClientRoutes<ReturnType<F>> {
	const defineEndpoint = createEndpoint.create({ use: [] });
	const endpoints = definition.endpoints(defineEndpoint);
	return toNamedClientRoutes(endpoints) as NamedClientRoutes<ReturnType<F>>;
}

export type GenerateNamedClientModuleOptions = {
	/**
	 * A TypeScript type expression for the endpoints record. Emitted verbatim to
	 * brand the manifest so the client infers types without a manual argument.
	 * Typically references the service via a type-only `import(...)`, e.g.
	 * `ReturnType<typeof import("./service").createTicketingService>["endpoints"]`.
	 */
	endpointsType: string;
	/** Name of the exported const. Defaults to `clientRoutes`. */
	exportName?: string;
	/** Import specifier for futonic's client types. Defaults to `futonic/client`. */
	clientModule?: string;
};

function renderRoute(route: NamedRoute): string {
	return `{ method: ${JSON.stringify(route.method)}, path: ${JSON.stringify(route.path)} }`;
}

/**
 * Generates the source of a static route-manifest module for the named client.
 * Write the returned string to a `.ts` file in the downstream package (e.g.
 * `Bun.write("src/client.generated.ts", generateNamedClientModule(def, opts))`)
 * and commit it so it is present at typecheck time.
 */
export function generateNamedClientModule<F extends EndpointsFactory>(
	definition: WithEndpoints<F>,
	options: GenerateNamedClientModuleOptions,
): string {
	const {
		endpointsType,
		exportName = "clientRoutes",
		clientModule = "futonic/client",
	} = options;

	const routes = extractClientRoutes(definition) as Record<string, NamedRoute>;
	const entries = Object.entries(routes)
		.map(([name, route]) => `\t${JSON.stringify(name)}: ${renderRoute(route)},`)
		.join("\n");

	return `import type { NamedClientRoutes } from ${JSON.stringify(clientModule)};

export const ${exportName}: NamedClientRoutes<${endpointsType}> = {
${entries}
};
`;
}
