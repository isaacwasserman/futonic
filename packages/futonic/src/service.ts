/**
 * The Futonic service constructor, built on better-call.
 *
 * Because endpoints are better-call `Endpoint`s and we expose the `router`, a
 * consumer gets a fully-inferred network client from
 * `createClient<typeof service.router>()` — no hand-rolled route manifest, no
 * threading of endpoint types. Endpoints are also directly callable, so
 * `service.endpoints` doubles as the in-process API.
 *
 * Service context (`db`, `config`, `logger`) is injected via a better-call
 * middleware, mirroring how better-auth injects its AuthContext. The same
 * context is bound into `serviceMethods` — arbitrary non-HTTP methods a service
 * can expose alongside its endpoints.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
	type Endpoint,
	type Middleware,
	type Router,
	createMiddleware,
	createRouter,
} from "better-call";
import type { ServiceDBSchema } from "./db-schema";
import { type InferDrizzleSchema, generateDrizzleSchema } from "./drizzle";
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
export type ServiceContext<TConfig extends Record<string, unknown>, TDb> = {
	db: TDb;
	config: TConfig;
	logger: Logger;
};

/** The better-call middleware type that carries the service context. */
export type ServiceMiddleware<
	TConfig extends Record<string, unknown>,
	TDb,
> = Middleware<
	// biome-ignore lint/suspicious/noExplicitAny: matches better-call's own middleware handler signature
	(inputCtx: Record<string, any>) => Promise<{
		serviceCtx: ServiceContext<TConfig, TDb>;
	}>
>;

/** Builds the middleware instance that injects the resolved service context. */
function createServiceMiddleware<TConfig extends ServiceConfig, TDb>(
	serviceCtx: ServiceContext<TConfig, TDb>,
): ServiceMiddleware<TConfig, TDb> {
	return createMiddleware(async () => ({ serviceCtx }));
}

// --- Service methods ------------------------------------------------------
// Non-HTTP methods a service exposes alongside its endpoints. Authored with a
// context argument (like an endpoint), then resolved by the constructor into
// context-free functions bound to the running service's context.

/** A service method implementation, with access to the service context. */
export type ServiceMethodImpl<
	TConfig extends ServiceConfig,
	TDb,
	TInput,
	TOutput,
> = (input: TInput, ctx: ServiceContext<TConfig, TDb>) => Promise<TOutput>;

// biome-ignore lint/suspicious/noExplicitAny: constraint for any method impl
export type AnyServiceMethodImpl = ServiceMethodImpl<any, any, any, any>;

/**
 * The helper passed to the `serviceMethods` factory. It's an identity function
 * at runtime, but as a generic it captures each method's input/output types.
 */
export type ServiceMethodBuilder<TConfig extends ServiceConfig, TDb> = <
	TInput,
	TOutput,
>(
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
	TConfig extends ServiceConfig,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
	TServiceId extends string,
> = {
	id: TServiceId;
	dbSchema: TDBSchema;
	configSchema: StandardSchemaV1<TConfig>;
	/**
	 * Define endpoints with better-call's `createEndpoint`, spreading the passed
	 * `use` middleware into each endpoint's `use` so handlers can read
	 * `ctx.context.serviceCtx` (typed `{ db, config, logger }`).
	 */
	endpoints: (
		use: [ServiceMiddleware<TConfig, KyselyFromServiceDBSchema<TDBSchema>>],
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

export type FutonicService<
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
	TDBSchema extends ServiceDBSchema = ServiceDBSchema,
	TProvider extends DatabaseProvider = DatabaseProvider,
	TServiceId extends string = string,
> = {
	/** HTTP entry point. */
	handler: (request: Request) => Promise<Response>;
	/**
	 * The better-call endpoints — directly callable in-process, and the source
	 * for the typesafe client: `createClient<typeof service.endpoints>()`.
	 */
	endpoints: TEndpoints;
	/** The better-call router (e.g. for mounting the service). */
	router: Router;
	/** Non-HTTP methods, resolved to context-free functions. */
	serviceMethods: ResolveServiceMethods<TServiceMethods>;
	/** Drizzle tables for migrations, keyed and SQL-named by the service id. */
	drizzleSchema: InferDrizzleSchema<TDBSchema, TProvider, TServiceId>;
};

export type FutonicServiceConstructor<
	TDBSchema extends ServiceDBSchema,
	TConfig extends ServiceConfig,
	TEndpoints extends Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl>,
	TServiceId extends string,
> = <TProvider extends DatabaseProvider>(options: {
	config: TConfig;
	database: { connection: DatabaseConnection; provider: TProvider };
	logger?: Logger;
}) => FutonicService<
	TEndpoints,
	TServiceMethods,
	TDBSchema,
	TProvider,
	TServiceId
>;

export function createFutonicServiceConstructor<
	TDBSchema extends ServiceDBSchema,
	TConfig extends ServiceConfig = Record<string, never>,
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
	TServiceMethods extends Record<string, AnyServiceMethodImpl> = Record<
		string,
		never
	>,
	TServiceId extends string = string,
>(
	definition: ServiceDefinition<
		TDBSchema,
		TConfig,
		TEndpoints,
		TServiceMethods,
		TServiceId
	>,
): FutonicServiceConstructor<
	TDBSchema,
	TConfig,
	TEndpoints,
	TServiceMethods,
	TServiceId
> {
	validateDefinition(definition.id, definition.dbSchema);

	return <TProvider extends DatabaseProvider>(options: {
		config: TConfig;
		database: { connection: DatabaseConnection; provider: TProvider };
		logger?: Logger;
	}) => {
		const { connection, provider } = options.database;

		// Validate the caller-provided config against the service's schema.
		const configResult = definition.configSchema["~standard"].validate(
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
		const config = configResult.value;

		const db = createKysely<TDBSchema>(connection, provider, definition.id);
		const logger = options.logger ?? createDefaultLogger(definition.id);
		const serviceCtx: ServiceContext<
			TConfig,
			KyselyFromServiceDBSchema<TDBSchema>
		> = { db, config, logger };

		const endpoints = definition.endpoints([
			createServiceMiddleware(serviceCtx),
		]);
		const router = createRouter(endpoints, { openapi: { disabled: true } });

		// Resolve service methods by binding the context away.
		const define = ((impl: AnyServiceMethodImpl) =>
			impl) as ServiceMethodBuilder<
			TConfig,
			KyselyFromServiceDBSchema<TDBSchema>
		>;
		const methodImpls = (definition.serviceMethods?.(define) ?? {}) as Record<
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
			/** HTTP entry point. */
			handler: (request: Request): Promise<Response> => router.handler(request),
			/** better-call endpoints are directly callable — the in-process API. */
			endpoints,
			/** Exposed so `createClient<typeof service.router>()` can infer routes. */
			router,
			/** Non-HTTP methods, bound to the service context. */
			serviceMethods,
			drizzleSchema: generateDrizzleSchema({
				serviceSchema: definition.dbSchema,
				dialect: provider,
				prefix: definition.id,
			}),
		};
	};
}

/** Re-export better-call's typesafe client for consumers. */
export { createClient } from "better-call/client";
