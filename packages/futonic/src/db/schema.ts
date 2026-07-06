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

/**
 * Maps a logical (unprefixed) table name to its prefixed counterpart.
 * Tables are prefixed with the service id so a service's tables never
 * collide with the host's own tables in the shared database.
 */
export function prefixTableName(serviceId: string, tableName: string): string {
	return `${serviceId}_${tableName}`;
}
