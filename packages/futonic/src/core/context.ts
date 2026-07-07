import type { InternalAdapter } from "../db/internal-adapter";
import type { ServiceDBSchema } from "../db/schema";

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

export interface MountInfo {
	baseURL: string;
	mountPath: string;
}

export interface ResolvedConfig {
	[key: string]: unknown;
}

export interface ServiceContext<
	TSchema extends ServiceDBSchema = ServiceDBSchema,
> {
	db: InternalAdapter<TSchema>;
	config: ResolvedConfig;
    logger: Logger;
	mountInfo: MountInfo;
}

export function createLogger(serviceId: string): Logger {
	const prefix = `[${serviceId}]`;
	return {
		info: (msg, ...args) => console.info(prefix, msg, ...args),
		warn: (msg, ...args) => console.warn(prefix, msg, ...args),
		error: (msg, ...args) => console.error(prefix, msg, ...args),
		debug: (msg, ...args) => console.debug(prefix, msg, ...args),
	};
}
