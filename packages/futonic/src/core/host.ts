import type { Kysely } from "kysely";
import { createLogger } from "./context";
import type { ServiceContext } from "./context";
import type { MountedService } from "./service";
import { createKyselyInstance, type DatabaseConnection } from "../db/kysely-factory";
import { createInternalAdapter } from "../db/internal-adapter";
import { getServiceTables } from "../db/schema";

export interface HostConfig {
	database?: DatabaseConnection;
	services: MountedService[];
	baseURL?: string;
}

export interface Host {
	services: Map<string, MountedService>;
	init(): Promise<void>;
	shutdown(): Promise<void>;
}

export function createHost(config: HostConfig): Host {
	const services = new Map<string, MountedService>();

	// Detect namespace collisions
	for (const service of config.services) {
		if (services.has(service.id)) {
			throw new Error(
				`Namespace collision: service id "${service.id}" is used by multiple services`,
			);
		}
		services.set(service.id, service);
	}

	// Compute merged schema (for CLI / introspection)
	const _allTables = getServiceTables(config.services);

	let kyselyInstance: Kysely<Record<string, unknown>> | undefined;

	return {
		services,

		async init() {
			// Create shared Kysely instance if any service needs a database
			const needsDb = config.services.some((s) => s.dependencies.database);
			if (needsDb) {
				if (!config.database) {
					throw new Error(
						"At least one service requires a database, but no database connection was provided",
					);
				}
				kyselyInstance = createKyselyInstance(config.database);
			}

			// Initialize each service
			for (const service of config.services) {
				const logger = createLogger(service.id);

				const serviceCtx: ServiceContext = {
					db: service.dependencies.database && kyselyInstance
						? createInternalAdapter(kyselyInstance, service.id, service.dbSchema)
						: (undefined as never),
					config: (service.mountConfig.config ?? {}) as Record<string, unknown>,
					logger,
					hostInfo: {
						baseURL: config.baseURL ?? "",
						mountPath: service.mountConfig.mount,
					},
				};

				service.serviceContext = serviceCtx;

				if (service.onInit) {
					await service.onInit(serviceCtx);
				}
			}

			// Fire onReady after all services are initialized
			for (const service of config.services) {
				if (service.onReady && service.serviceContext) {
					await service.onReady(service.serviceContext);
				}
			}
		},

		async shutdown() {
			for (const service of config.services) {
				if (service.onShutdown) {
					await service.onShutdown();
				}
			}
			if (kyselyInstance) {
				await kyselyInstance.destroy();
			}
		},
	};
}
