export type ColumnDefinition = {
	name?: string;
	type:
		| "string"
		| "integer"
		| "boolean"
		| "timestamp"
		| "json"
		| "blob"
		| "enum";
	enumValues?: readonly unknown[];
	optional?: boolean;
	primaryKey?: boolean;
	defaultValue?: unknown;
	references?: {
		table: string;
		column: string;
		onDelete?: "cascade" | "restrict" | "set-null";
	};
};

export type TableDefinition = {
	name: string;
	columns: Record<string, ColumnDefinition>;
};

export type ServiceDBSchema = {
	tables: Record<string, TableDefinition>;
};
