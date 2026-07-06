import type { MountedService } from "../core/service";

export interface FieldDefinition {
	type: "string" | "number" | "boolean" | "date" | "json" | "binary";
	required?: boolean;
	unique?: boolean;
	primaryKey?: boolean;
	defaultValue?: unknown;
	enum?: string[];
	references?: {
		model: string;
		field: string;
		onDelete?: "cascade" | "restrict" | "set-null";
	};
}

export interface TableDefinition {
	fields: Record<string, FieldDefinition>;
}

export interface ServiceDBSchema {
	tables: Record<string, TableDefinition>;
}

export interface PrefixedTable {
	originalName: string;
	prefixedName: string;
	serviceId: string;
	fields: Record<string, FieldDefinition>;
}

/**
 * Collects all mounted services' dbSchema values, applies `{serviceId}_` prefix,
 * and returns a unified map of prefixed table name → table definition.
 */
export function getServiceTables(
	services: MountedService[],
): Map<string, PrefixedTable> {
	const result = new Map<string, PrefixedTable>();

	for (const service of services) {
		if (!service.dbSchema) continue;

		for (const [tableName, tableDef] of Object.entries(
			service.dbSchema.tables,
		)) {
			const prefixedName = `${service.id}_${tableName}`;

			if (result.has(prefixedName)) {
				throw new Error(
					`Table name collision: "${prefixedName}" is defined by multiple services`,
				);
			}

			result.set(prefixedName, {
				originalName: tableName,
				prefixedName,
				serviceId: service.id,
				fields: tableDef.fields,
			});
		}
	}

	return result;
}

/**
 * Maps a logical (unprefixed) table name to its prefixed counterpart.
 */
export function prefixTableName(serviceId: string, tableName: string): string {
	return `${serviceId}_${tableName}`;
}
