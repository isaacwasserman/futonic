/** The Futonic service constructor, built on better-call. */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type Endpoint,
	type Middleware,
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

/**
 * A pre-bound `createEndpoint` that spreads the service middleware into every
 * endpoint's `use`, so handlers read `ctx.context.serviceCtx` (typed
 * `{ db, config, logger }`) without wiring middleware per endpoint.
 */
export type DefineEndpoint<TConfig, TDb> = ReturnType<
	typeof createEndpoint.create<{ use: [ServiceMiddleware<TConfig, TDb>] }>
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

export type HandlerOptions = {
	/** Mount path to strip before routing (e.g. `/api/servicedesk`, or `/` at root). */
	basePath: string;
};

export type FutonicService<
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
> = {
	/** HTTP entry point. */
	handler: (request: Request, options: HandlerOptions) => Promise<Response>;
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

export type FutonicServiceConstructor<
	TConfig,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
> = (options: {
	config: TConfig;
	database: { connection: DatabaseConnection; provider: DatabaseProvider };
	logger?: Logger;
}) => FutonicService<TEndpoints, TServiceMethods>;

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

	return (options: {
		config: TConfig;
		database: { connection: DatabaseConnection; provider: DatabaseProvider };
		logger?: Logger;
	}) => {
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

		const defineEndpoint = createEndpoint.create({
			use: [createServiceMiddleware(serviceCtx)],
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
			handler: (request: Request, options: HandlerOptions): Promise<Response> =>
				router.handler(stripBasePath(request, options.basePath)),
			endpoints,
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
