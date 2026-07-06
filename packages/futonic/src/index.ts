// Core
export { createService } from "./core/service";
export type {
	EmbeddableService,
	RunnableService,
	ServiceConfig,
} from "./core/service";
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
} from "./db/schema";
export type { DatabaseConnection } from "./db/kysely-factory";
export type {
	InternalAdapter,
	TableAdapter,
	FindManyOptions,
	Where,
} from "./db/internal-adapter";
