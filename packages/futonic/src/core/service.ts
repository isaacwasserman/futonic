import type { Endpoint, Middleware } from "better-call";
import type { DrizzleDatabase } from "../db/kysely-factory";
import type { ServiceDBSchema } from "../db/schema";
import type { ServiceContext } from "./context";
import { createServiceRuntime } from "./runtime";

export interface ServiceConfig<TConfig = unknown> {
	/** HTTP mount path, e.g. "/api/billing". Becomes the better-call router basePath. */
	// mount: string;
	/** Drizzle instance the service opens its own Kysely connection from (via its `$client`). Required iff the service declares a dbSchema. */
	database: DrizzleDatabase;
	/** Absolute base URL surfaced to endpoints via ctx.hostInfo.baseURL. */
	// baseURL?: string;
	/** Service-specific resolved config, surfaced as ctx.config. */
	config?: TConfig;
}

export interface EmbeddableService<
	TConfig = unknown,
	TSchema extends ServiceDBSchema = ServiceDBSchema,
	TEndpoints extends Record<string, Endpoint> = Record<string, Endpoint>,
> {
	id: string;
	version: string;
	/** Presence of a schema means the service needs a database. */
	dbSchema?: TSchema;
	/** Factory: futonic passes the ServiceContext-injecting middleware; returns the endpoint map. */
	endpoints: (use: Middleware[]) => TEndpoints;
	onInit?: (ctx: ServiceContext<TSchema>) => Promise<void>;
	onShutdown?: () => Promise<void>;
}

/**
 * The runnable object returned by the service factory. The host calls
 * init()/handler()/shutdown() on it without ever touching futonic itself.
 */
export interface RunnableService<
	TSchema extends ServiceDBSchema = ServiceDBSchema,
> {
	id: string;
	version: string;
	createHandler(mountInfo: { baseURL: string; mountPath: string }): Promise<
		(request: Request) => Promise<Response>
	>;
}

export function createService<
	TConfig,
	TSchema extends ServiceDBSchema,
	TEndpoints extends Record<string, Endpoint>,
>(
	definition: EmbeddableService<TConfig, TSchema, TEndpoints>,
): (config: ServiceConfig<TConfig>) => RunnableService<TSchema> {
	return (config: ServiceConfig<TConfig>) =>
		createServiceRuntime(definition, config);
}
