import type { FieldDefinition, PrefixedTable } from "../../db/schema";

/**
 * Generates raw SQL DDL from the collected service tables.
 * Forked from better-auth's CLI generator pattern.
 */
export async function generateKyselySchema(outPath?: string) {
	const output = outPath ?? "futonic-schema.sql";
	console.log(`[futonic] SQL schema generation → ${output}`);
	console.log("[futonic] Not yet implemented — requires host config loading");
}

/**
 * Converts a PrefixedTable to a CREATE TABLE SQL statement.
 */
export function tableToSQL(table: PrefixedTable): string {
	const columns: string[] = [];

	for (const [fieldName, field] of Object.entries(table.fields)) {
		columns.push(`\t${fieldName} ${fieldToSQLType(field)}`);
	}

	// Add foreign key constraints
	for (const [fieldName, field] of Object.entries(table.fields)) {
		if (field.references) {
			const onDelete = field.references.onDelete ?? "restrict";
			const action = onDelete === "set-null" ? "SET NULL" : onDelete.toUpperCase();
			columns.push(
				`\tFOREIGN KEY (${fieldName}) REFERENCES ${field.references.model}(${field.references.field}) ON DELETE ${action}`,
			);
		}
	}

	return `CREATE TABLE IF NOT EXISTS ${table.prefixedName} (\n${columns.join(",\n")}\n);`;
}

function fieldToSQLType(field: FieldDefinition): string {
	let type: string;

	switch (field.type) {
		case "string":
			type = "TEXT";
			break;
		case "number":
			type = "INTEGER";
			break;
		case "boolean":
			type = "BOOLEAN";
			break;
		case "date":
			type = "TIMESTAMP";
			break;
		case "json":
			type = "JSONB";
			break;
		default:
			type = "TEXT";
	}

	const parts = [type];
	if (field.primaryKey) parts.push("PRIMARY KEY");
	if (field.required) parts.push("NOT NULL");
	if (field.unique) parts.push("UNIQUE");
	if (field.defaultValue !== undefined) {
		parts.push(`DEFAULT ${JSON.stringify(field.defaultValue)}`);
	}

	return parts.join(" ");
}
