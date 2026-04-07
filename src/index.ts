// Core
export { createService } from "./core/service";
export type {
	EmbeddableService,
	MountedService,
	ServiceConfig,
} from "./core/service";
export { createHost } from "./core/host";
export type { HostConfig, Host } from "./core/host";
export type {
	ServiceContext,
	Logger,
	HostInfo,
	ResolvedConfig,
} from "./core/context";

// Database
export type {
	ServiceDBSchema,
	TableDefinition,
	FieldDefinition,
	PrefixedTable,
} from "./db/schema";
export { getServiceTables, prefixTableName } from "./db/schema";
export type { InternalAdapter, TableAdapter, FindManyOptions } from "./db/internal-adapter";

// Router
export { createServiceEndpoint } from "./router/endpoint";
export { createServiceMiddleware } from "./router/middleware";

// Standard Schema
export { toZodCompat } from "./standard-schema";
export type { StandardSchema } from "./standard-schema";
