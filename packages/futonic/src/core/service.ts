import type { ServiceDBSchema } from "../db/schema";
import type { ServiceContext } from "./context";

export interface ServiceConfig<TConfig = unknown> {
	mount: string;
	middleware?: unknown[];
	config?: TConfig;
}

export interface EmbeddableService<
	TConfig = unknown,
	TSchema extends ServiceDBSchema = ServiceDBSchema,
	TEndpoints extends Record<string, unknown> = Record<string, unknown>,
> {
	id: string;
	version: string;
	dependencies: {
		database: boolean;
	};
	dbSchema?: TSchema;
	endpoints: TEndpoints;
	onInit?: (ctx: ServiceContext<TSchema>) => Promise<void>;
	onReady?: (ctx: ServiceContext<TSchema>) => Promise<void>;
	onShutdown?: () => Promise<void>;
}

export interface MountedService<
	TConfig = unknown,
	TSchema extends ServiceDBSchema = ServiceDBSchema,
	TEndpoints extends Record<string, unknown> = Record<string, unknown>,
> extends EmbeddableService<TConfig, TSchema, TEndpoints> {
	mountConfig: ServiceConfig<TConfig>;
	serviceContext?: ServiceContext<TSchema>;
}

export function createService<
	TConfig,
	TSchema extends ServiceDBSchema,
	TEndpoints extends Record<string, unknown>,
>(
	definition: EmbeddableService<TConfig, TSchema, TEndpoints>,
): (
	config: ServiceConfig<TConfig>,
) => MountedService<TConfig, TSchema, TEndpoints> {
	return (config: ServiceConfig<TConfig>) => ({
		...definition,
		mountConfig: config,
	});
}
