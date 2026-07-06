import { type Endpoint, createRouter } from "better-call";
import type { Kysely } from "kysely";
import { createInternalAdapter } from "../db/internal-adapter";
import { createKyselyInstance } from "../db/kysely-factory";
import type { ServiceDBSchema } from "../db/schema";
import { createServiceMiddleware } from "../router/middleware";
import { type ServiceContext, createLogger } from "./context";
import type {
	EmbeddableService,
	RunnableService,
	ServiceConfig,
} from "./service";

/**
 * Turns a service definition + mount config into a self-running unit: it opens
 * its own database connection, builds its own router, and manages its own
 * lifecycle. The host just calls init()/handler()/shutdown().
 */
export function createServiceRuntime<
	TConfig,
	TSchema extends ServiceDBSchema,
	TEndpoints extends Record<string, Endpoint>,
>(
	definition: EmbeddableService<TConfig, TSchema, TEndpoints>,
	config: ServiceConfig<TConfig>,
): RunnableService<TSchema> {
	let kysely: Kysely<Record<string, unknown>> | undefined;
	let router: { handler(request: Request): Promise<Response> } | undefined;
	let initialized = false;

	const service: RunnableService<TSchema> = {
		id: definition.id,
		version: definition.version,
		serviceContext: undefined,

		async init() {
			if (initialized) {
				throw new Error(`Service "${definition.id}" is already initialized`);
			}

			const needsDb = !!definition.dbSchema;
			if (needsDb) {
				if (!config.database) {
					throw new Error(
						`Service "${definition.id}" requires a database, but no database connection was provided`,
					);
				}
				kysely = createKyselyInstance(config.database);
			}

			const serviceCtx: ServiceContext<TSchema> = {
				db:
					needsDb && kysely
						? createInternalAdapter(kysely, definition.id, definition.dbSchema)
						: (undefined as never),
				config: (config.config ?? {}) as Record<string, unknown>,
				logger: createLogger(definition.id),
				hostInfo: {
					baseURL: config.baseURL ?? "",
					mountPath: config.mount,
				},
			};
			service.serviceContext = serviceCtx;

			const endpoints = definition.endpoints([
				createServiceMiddleware(serviceCtx),
			]);
			router = createRouter(endpoints, {
				basePath: config.mount,
				openapi: { disabled: true },
			});

			await definition.onInit?.(serviceCtx);
			initialized = true;
		},

		async handler(request) {
			if (!router) {
				throw new Error(
					`Service "${definition.id}" is not initialized — call init() first`,
				);
			}
			return router.handler(request);
		},

		async shutdown() {
			if (!initialized) return;
			await definition.onShutdown?.();
			if (kysely && (config.destroyDatabaseOnShutdown ?? true)) {
				await kysely.destroy();
			}
		},
	};

	return service;
}
