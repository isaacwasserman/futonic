/** The Futonic service constructor, built on better-call. */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type Endpoint,
	type EndpointContext,
	type EndpointMetadata,
	type EndpointRuntimeOptions,
	type HTTPMethod,
	type Middleware,
	type ResolveBodyInput,
	type ResolveErrorInput,
	type ResolveMetaInput,
	type ResolveQueryInput,
	type Router,
	createEndpoint,
	createMiddleware,
	createRouter,
} from "better-call";
import type { ServiceDBSchema } from "./db-schema";
import {
	type DrizzleBuilders,
	type DrizzleDialect,
	type InferDrizzleSchema,
	generateDrizzleSchema,
} from "./drizzle";
import {
	type DatabaseConnection,
	type DatabaseProvider,
	type KyselyFromServiceDBSchema,
	createKysely,
} from "./kysely";
import {
	OUTPUT_METADATA_KEY,
	type OpenApiOptions,
	generateOpenApiDocument,
	openApiReferenceHtml,
} from "./openapi";

/** A minimal structured logger. `console` satisfies this shape. */
export type Logger = {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
};

/** Default logger: `console`, prefixed with the service id. */
function createDefaultLogger(id: string): Logger {
	const prefix = `[${id}]`;
	return {
		info: (...args) => console.info(prefix, ...args),
		warn: (...args) => console.warn(prefix, ...args),
		error: (...args) => console.error(prefix, ...args),
		debug: (...args) => console.debug(prefix, ...args),
	};
}

// biome-ignore lint/complexity/noBannedTypes: `{}` intentionally allows an empty config
export type ServiceConfig = Record<string, unknown> | {};

/** The context handed to every endpoint and service method. */
export type ServiceContext<TConfig, TDb> = {
	db: TDb;
	config: TConfig;
	logger: Logger;
};

/** The better-call middleware type that carries the service context. */
export type ServiceMiddleware<TConfig, TDb> = Middleware<
	// biome-ignore lint/suspicious/noExplicitAny: matches better-call's own middleware handler signature
	(inputCtx: Record<string, any>) => Promise<{
		serviceCtx: ServiceContext<TConfig, TDb>;
	}>
>;

/** Builds the middleware instance that injects the resolved service context. */
function createServiceMiddleware<TConfig, TDb>(
	serviceCtx: ServiceContext<TConfig, TDb>,
): ServiceMiddleware<TConfig, TDb> {
	return createMiddleware(async () => ({ serviceCtx }));
}

/** Resolves the handler's return / endpoint result type from an optional output schema. */
type InferEndpointResult<OutputSchema, R> =
	OutputSchema extends StandardSchemaV1
		? StandardSchemaV1.InferOutput<OutputSchema>
		: R;

/**
 * A pre-bound `createEndpoint` that spreads the service middleware into every
 * endpoint's `use`, so handlers read `ctx.context.serviceCtx` (typed
 * `{ db, config, logger }`) without wiring middleware per endpoint. The typed
 * `metadata.openapi.security` used per-endpoint comes from better-call itself.
 *
 * Reconstructs better-call's `createEndpoint.create` signature so it can add an
 * `output` option: a Standard Schema whose inferred output the handler's return
 * must match (checked at compile time only) and which is emitted as the `200`
 * response schema in the OpenAPI document.
 */
export type DefineEndpoint<TConfig, TDb> = <
	Path extends string,
	Method extends HTTPMethod | HTTPMethod[] | "*",
	BodySchema extends object | undefined = undefined,
	QuerySchema extends object | undefined = undefined,
	ReqHeaders extends boolean = false,
	ReqRequest extends boolean = false,
	Meta extends EndpointMetadata | undefined = undefined,
	ErrorSchema extends StandardSchemaV1 | undefined = undefined,
	OutputSchema extends StandardSchemaV1 | undefined = undefined,
	R = unknown,
>(
	path: Path,
	options: Omit<
		EndpointRuntimeOptions,
		| "method"
		| "body"
		| "query"
		| "error"
		| "requireHeaders"
		| "requireRequest"
		| "metadata"
	> & {
		method: Method;
		body?: BodySchema;
		query?: QuerySchema;
		requireHeaders?: ReqHeaders;
		requireRequest?: ReqRequest;
		error?: ErrorSchema;
		metadata?: Meta;
		/**
		 * Standard Schema whose inferred output the handler's return must match
		 * (compile-time only, not validated at runtime). Emitted as the `200`
		 * response schema in the OpenAPI document.
		 */
		output?: OutputSchema;
	},
	handler: (
		ctx: EndpointContext<
			Path,
			Method,
			BodySchema,
			QuerySchema,
			[ServiceMiddleware<TConfig, TDb>],
			ReqHeaders,
			ReqRequest,
			{ serviceCtx: ServiceContext<TConfig, TDb> },
			Meta
		>,
	) => Promise<InferEndpointResult<OutputSchema, R>>,
) => Endpoint<
	Path,
	Method,
	ResolveBodyInput<BodySchema, Meta>,
	ResolveQueryInput<QuerySchema, Meta>,
	[ServiceMiddleware<TConfig, TDb>],
	Awaited<InferEndpointResult<OutputSchema, R>>,
	ResolveMetaInput<Meta>,
	ResolveErrorInput<ErrorSchema, Meta>
>;

// --- Service methods ------------------------------------------------------

/** A service method implementation, with access to the service context. */
export type ServiceMethodImpl<TConfig, TDb, TInput, TOutput> = (
	input: TInput,
	ctx: ServiceContext<TConfig, TDb>,
) => Promise<TOutput>;

// biome-ignore lint/suspicious/noExplicitAny: constraint for any method impl
export type AnyServiceMethodImpl = ServiceMethodImpl<any, any, any, any>;

/**
 * The helper passed to the `serviceMethods` factory. It's an identity function
 * at runtime, but as a generic it captures each method's input/output types.
 */
export type ServiceMethodBuilder<TConfig, TDb> = <TInput, TOutput>(
	impl: ServiceMethodImpl<TConfig, TDb, TInput, TOutput>,
) => ServiceMethodImpl<TConfig, TDb, TInput, TOutput>;

/** Resolves an authored method impl to the context-free method on the service. */
export type ResolveServiceMethods<
	T extends Record<string, AnyServiceMethodImpl>,
> = {
	[K in keyof T]: T[K] extends (
		input: infer TInput,
		// biome-ignore lint/suspicious/noExplicitAny: ctx is bound away
		ctx: any,
	) => infer TReturn
		? (input: TInput) => TReturn
		: never;
};

export type ServiceDefinition<
	TDBSchema extends ServiceDBSchema,
	TConfigSchema extends StandardSchemaV1<unknown, ServiceConfig>,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
	TServiceId extends string,
	TConfig = StandardSchemaV1.InferOutput<TConfigSchema>,
> = {
	id: TServiceId;
	dbSchema: TDBSchema;
	configSchema: TConfigSchema;
	/**
	 * Define endpoints with the passed `defineEndpoint` helper — a `createEndpoint`
	 * that already carries the service middleware, so handlers can read
	 * `ctx.context.serviceCtx` (typed `{ db, config, logger }`).
	 */
	endpoints: (
		defineEndpoint: DefineEndpoint<
			TConfig,
			KyselyFromServiceDBSchema<TDBSchema>
		>,
	) => TEndpoints;
	/**
	 * Define non-HTTP methods via the passed `define` helper; each receives the
	 * service context as its second argument. They are resolved to context-free
	 * functions under `service.serviceMethods`.
	 */
	serviceMethods?: (
		define: ServiceMethodBuilder<TConfig, KyselyFromServiceDBSchema<TDBSchema>>,
	) => TServiceMethods;
};

/**
 * Db-erased view of a {@link ServiceDefinition} returned by `defineService`:
 * the Kysely-typed builder params become `never` so a downstream service that
 * exports its definition doesn't drag `Kysely<Schema>` into its public types.
 */
export type ServiceBlueprint<
	TDBSchema extends ServiceDBSchema,
	TConfigSchema extends StandardSchemaV1<unknown, ServiceConfig>,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
	TServiceId extends string,
> = {
	id: TServiceId;
	dbSchema: TDBSchema;
	configSchema: TConfigSchema;
	endpoints: (defineEndpoint: never) => TEndpoints;
	serviceMethods?: (define: never) => TServiceMethods;
};

/** Strips the host's mount path so the router's root-defined endpoints match. */
function stripBasePath(request: Request, basePath: string): Request {
	if (basePath === "" || basePath === "/") return request;
	const url = new URL(request.url);
	if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
		return request;
	}
	url.pathname = url.pathname.slice(basePath.length) || "/";
	return new Request(url, request);
}

/** Validates the static definition once, up front. */
function validateDefinition(id: string, dbSchema: ServiceDBSchema): void {
	if (!/^[a-z]+$/.test(id)) {
		throw new Error(
			`Invalid service id "${id}": must contain only lowercase letters (a-z).`,
		);
	}
	for (const [tableKey, tableDef] of Object.entries(dbSchema.tables)) {
		if (!/^[a-z][a-zA-Z]*$/.test(tableKey)) {
			throw new Error(
				`Invalid schema key "${tableKey}": table keys must be camelCase (letters only, starting with a lowercase letter).`,
			);
		}
		if (!/^[a-z]+(?:_[a-z]+)*$/.test(tableDef.name)) {
			throw new Error(
				`Invalid table name "${tableDef.name}" for key "${tableKey}": table names must be snake_case (lowercase letters separated by underscores).`,
			);
		}
	}
}

const DEFAULT_OPENAPI_OPTIONS: OpenApiOptions = {
	disabled: false,
	path: "/reference",
};

export type HandlerOptions = {
	/** Mount path to strip before routing (e.g. `/api/servicedesk`, or `/` at root). */
	basePath: string;
	/**
	 * Configure the OpenAPI reference route. Enabled at `/reference` by default;
	 * pass `false` to disable it, or override individual fields.
	 */
	openApi?: OpenApiOptions | false;
};

export type FutonicHandler = {
	/** HTTP entry point for a configured handler. */
	handle: (request: Request) => Promise<Response>;
};

export type FutonicService<
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
> = {
	/** Builds a configured HTTP handler. */
	createHandler: (options: HandlerOptions) => FutonicHandler;
	/**
	 * The better-call endpoints — directly callable in-process, and the source
	 * for the typesafe client: `createClient<typeof service.endpoints>()`.
	 */
	endpoints: TEndpoints;
	/** The better-call router (e.g. for mounting the service). */
	router: Router;
	/** Non-HTTP methods, resolved to context-free functions. */
	serviceMethods: ResolveServiceMethods<TServiceMethods>;
};

/**
 * The service factory returned by {@link createFutonicServiceConstructor}.
 *
 * Its call signature takes an optional `TEndpointsOverride` type argument that
 * re-types the returned `endpoints` (and therefore the typesafe client derived
 * from them). It defaults to the endpoints inferred from the definition, so
 * plain calls are unaffected. A downstream service that parameterizes an
 * endpoint's schema by a caller-supplied type (e.g. a typed metadata payload)
 * passes the matching re-typed endpoints here to surface that type end-to-end
 * without an `as`-cast at the call site — the runtime endpoints are identical.
 */
export type FutonicServiceConstructor<
	TConfig,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
> = <
	TEndpointsOverride extends Record<string, Endpoint> = TEndpoints,
>(options: {
	config: TConfig;
	database: { connection: DatabaseConnection; provider: DatabaseProvider };
	logger?: Logger;
}) => FutonicService<TEndpointsOverride, TServiceMethods>;

/**
 * Identity helper that captures a service definition's types so the same
 * definition can be shared between `createFutonicServiceConstructor` and
 * `generateServiceDrizzleSchema`.
 */
export function defineService<
	const TDBSchema extends ServiceDBSchema,
	TConfigSchema extends StandardSchemaV1<
		unknown,
		ServiceConfig
	> = StandardSchemaV1<unknown, Record<string, never>>,
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
	TServiceId extends string = string,
>(
	definition: ServiceDefinition<
		TDBSchema,
		TConfigSchema,
		TEndpoints,
		TServiceMethods,
		TServiceId
	>,
): ServiceBlueprint<
	TDBSchema,
	TConfigSchema,
	TEndpoints,
	TServiceMethods,
	TServiceId
> {
	return definition;
}

export function createFutonicServiceConstructor<
	TDBSchema extends ServiceDBSchema,
	TConfigSchema extends StandardSchemaV1<
		unknown,
		ServiceConfig
	> = StandardSchemaV1<unknown, Record<string, never>>,
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
	TServiceId extends string = string,
	TConfig = StandardSchemaV1.InferOutput<TConfigSchema>,
>(
	definition: ServiceBlueprint<
		TDBSchema,
		TConfigSchema,
		TEndpoints,
		TServiceMethods,
		TServiceId
	>,
): FutonicServiceConstructor<TConfig, TEndpoints, TServiceMethods> {
	validateDefinition(definition.id, definition.dbSchema);

	// Recover the erased builder params to invoke the callbacks.
	const authored = definition as unknown as ServiceDefinition<
		TDBSchema,
		TConfigSchema,
		TEndpoints,
		TServiceMethods,
		TServiceId,
		TConfig
	>;

	return <
		TEndpointsOverride extends Record<string, Endpoint> = TEndpoints,
	>(options: {
		config: TConfig;
		database: { connection: DatabaseConnection; provider: DatabaseProvider };
		logger?: Logger;
	}): FutonicService<TEndpointsOverride, TServiceMethods> => {
		const { connection, provider } = options.database;

		const configResult = authored.configSchema["~standard"].validate(
			options.config,
		);
		if (configResult instanceof Promise) {
			throw new Error(
				`Service "${definition.id}" has an async config schema; only synchronous validation is supported.`,
			);
		}
		if (configResult.issues) {
			throw new Error(
				`Invalid config for service "${definition.id}": ${configResult.issues
					.map((issue) => issue.message)
					.join(", ")}`,
			);
		}
		const config = configResult.value as TConfig;

		const db = createKysely<TDBSchema>(connection, provider, definition.id);
		const logger = options.logger ?? createDefaultLogger(definition.id);
		const serviceCtx: ServiceContext<
			TConfig,
			KyselyFromServiceDBSchema<TDBSchema>
		> = { db, config, logger };

		const baseDefineEndpoint = createEndpoint.create({
			use: [createServiceMiddleware(serviceCtx)],
		});
		// better-call rebuilds its runtime options from a fixed key set, dropping
		// unknown ones — so relocate `output` onto `metadata` (which it preserves)
		// where the OpenAPI generator reads it.
		const defineEndpoint = ((
			path: string,
			options: Record<string, unknown>,
			handler: unknown,
		) => {
			const { output, metadata, ...rest } = options as {
				output?: unknown;
				metadata?: Record<string, unknown>;
			};
			const resolved = output
				? { ...rest, metadata: { ...metadata, [OUTPUT_METADATA_KEY]: output } }
				: options;
			// biome-ignore lint/suspicious/noExplicitAny: forwarding to better-call's generic factory
			return (baseDefineEndpoint as any)(path, resolved, handler);
		}) as DefineEndpoint<TConfig, KyselyFromServiceDBSchema<TDBSchema>>;
		const endpoints = authored.endpoints(defineEndpoint);
		const router = createRouter(endpoints, { openapi: { disabled: true } });

		const define = ((impl: AnyServiceMethodImpl) =>
			impl) as ServiceMethodBuilder<
			TConfig,
			KyselyFromServiceDBSchema<TDBSchema>
		>;
		const methodImpls = (authored.serviceMethods?.(define) ?? {}) as Record<
			string,
			AnyServiceMethodImpl
		>;
		const serviceMethods = Object.fromEntries(
			Object.entries(methodImpls).map(([name, impl]) => [
				name,
				(input: unknown) => impl(input, serviceCtx),
			]),
		) as ResolveServiceMethods<TServiceMethods>;

		return {
			createHandler: (handlerOptions: HandlerOptions): FutonicHandler => {
				const openApi: OpenApiOptions =
					handlerOptions.openApi === false
						? { disabled: true }
						: { ...DEFAULT_OPENAPI_OPTIONS, ...handlerOptions.openApi };

				const routeEndpoints = { ...endpoints } as Record<string, Endpoint>;
				if (!openApi.disabled) {
					let rendered: Promise<{ json: string; html: string }> | null = null;
					const render = () => {
						if (!rendered) {
							rendered = generateOpenApiDocument(endpoints, openApi).then(
								(doc) => ({
									json: JSON.stringify(doc),
									html: openApiReferenceHtml(doc, openApi.theme),
								}),
							);
						}
						return rendered;
					};
					routeEndpoints.openapi = createEndpoint(
						openApi.path ?? "/reference",
						{ method: "GET" },
						async (ctx) => {
							const { json, html } = await render();
							const accept =
								(ctx as { request?: Request }).request?.headers.get("accept") ??
								"";
							if (accept.includes("application/json")) {
								return new Response(json, {
									headers: { "Content-Type": "application/json" },
								});
							}
							return new Response(html, {
								headers: { "Content-Type": "text/html" },
							});
						},
					) as unknown as Endpoint;
				}

				const configuredRouter = createRouter(routeEndpoints, {
					openapi: { disabled: true },
				});
				return {
					handle: (request: Request): Promise<Response> =>
						configuredRouter.handler(
							stripBasePath(request, handlerOptions.basePath),
						),
				};
			},
			// The runtime endpoints are the definition's; `TEndpointsOverride` is a
			// caller-supplied re-typing (identical shape, narrowed payload types).
			endpoints: endpoints as unknown as TEndpointsOverride,
			router,
			serviceMethods,
		};
	};
}

/**
 * Builds a service's Drizzle tables from its definition and a target dialect —
 * independent of any runtime config or database connection. Downstream services
 * can wrap this and bake in their own definition so callers pass only a dialect;
 * host applications then create the service's tables in Drizzle from the dialect.
 */
export function generateServiceDrizzleSchema<
	const TDBSchema extends ServiceDBSchema,
	TServiceId extends string,
	D extends DrizzleDialect,
	TDrizzle extends DrizzleBuilders,
>(
	definition: { id: TServiceId; dbSchema: TDBSchema },
	dialect: D,
	drizzle: TDrizzle,
): InferDrizzleSchema<TDBSchema, D, TServiceId, TDrizzle> {
	return generateDrizzleSchema({
		serviceSchema: definition.dbSchema,
		dialect,
		prefix: definition.id,
		drizzle,
	});
}

/** Re-export better-call's typesafe client for consumers. */
export { createClient } from "better-call/client";
