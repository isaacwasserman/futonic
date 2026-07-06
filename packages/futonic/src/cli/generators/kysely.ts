/**
 * Raw SQL DDL generator for Kysely / plain SQL migrations.
 *
 * better-auth's kysely generator delegates to `getMigrations()` which
 * compiles DDL from their internal schema. We do the same thing here,
 * generating CREATE TABLE statements from our PrefixedTable IR.
 *
 * Forked approach from better-auth `packages/cli/src/generators/kysely.ts` (MIT).
 */

import type { FieldDefinition, PrefixedTable } from "../../db/schema";
import type { DatabaseProvider, SchemaGenerator } from "./types";

export const generateKyselySchema: SchemaGenerator = async ({
	tables,
	provider,
	file,
}) => {
	const statements: string[] = [];

	for (const [, table] of tables) {
		statements.push(tableToSQL(table, provider));
	}

	const code = statements.join("\n\n");

	return {
		code: code.trim() || "",
		fileName:
			file ||
			`./futonic_migrations/${new Date().toISOString().replace(/:/g, "-")}.sql`,
	};
};

/**
 * Converts a PrefixedTable to a CREATE TABLE SQL statement.
 */
export function tableToSQL(
	table: PrefixedTable,
	provider: DatabaseProvider = "pg",
): string {
	const columns: string[] = [];

	for (const [fieldName, field] of Object.entries(table.fields)) {
		columns.push(`  ${fieldName} ${fieldToSQLType(field, provider)}`);
	}

	// Add foreign key constraints
	for (const [fieldName, field] of Object.entries(table.fields)) {
		if (field.references) {
			const onDelete = field.references.onDelete ?? "restrict";
			const action =
				onDelete === "set-null" ? "SET NULL" : onDelete.toUpperCase();
			const referencedTable = `${table.serviceId}_${field.references.model}`;
			columns.push(
				`  FOREIGN KEY (${fieldName}) REFERENCES ${referencedTable}(${field.references.field}) ON DELETE ${action}`,
			);
		}
	}

	return `CREATE TABLE IF NOT EXISTS ${table.prefixedName} (\n${columns.join(",\n")}\n);`;
}

/**
 * Maps a field definition to its SQL type string, varying by provider.
 * Follows the same provider-aware mapping as the Drizzle generator.
 */
function fieldToSQLType(
	field: FieldDefinition,
	provider: DatabaseProvider,
): string {
	let type: string;

	switch (field.type) {
		case "string":
			if (provider === "mysql" && (field.unique || field.references)) {
				type = "VARCHAR(255)";
			} else {
				type = "TEXT";
			}
			break;
		case "number":
			type = provider === "mysql" ? "INT" : "INTEGER";
			break;
		case "boolean":
			type = provider === "sqlite" ? "INTEGER" : "BOOLEAN";
			break;
		case "date":
			type = provider === "sqlite" ? "INTEGER" : "TIMESTAMP";
			break;
		case "json":
			if (provider === "pg") type = "JSONB";
			else if (provider === "mysql") type = "JSON";
			else type = "TEXT";
			break;
		case "binary":
			if (provider === "pg") type = "BYTEA";
			else if (provider === "mysql") type = "LONGBLOB";
			else type = "BLOB";
			break;
		default:
			type = "TEXT";
	}

	const parts = [type];
	if (field.primaryKey) parts.push("PRIMARY KEY");
	if (field.required) parts.push("NOT NULL");
	if (field.unique) parts.push("UNIQUE");
	if (field.defaultValue !== undefined) {
		if (typeof field.defaultValue === "string") {
			parts.push(`DEFAULT '${field.defaultValue}'`);
		} else {
			parts.push(`DEFAULT ${field.defaultValue}`);
		}
	}

	return parts.join(" ");
}
