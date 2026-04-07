import type { FieldDefinition, PrefixedTable } from "../../db/schema";

/**
 * Generates a Drizzle schema file from the collected service tables.
 * Forked from better-auth's CLI generator pattern.
 */
export async function generateDrizzleSchema(outPath?: string) {
	// TODO: Load host config and collect service tables
	// For now, this is a placeholder that shows the generation pattern
	const output = outPath ?? "futonic-schema.ts";
	console.log(`[futonic] Drizzle schema generation → ${output}`);
	console.log("[futonic] Not yet implemented — requires host config loading");
}

/**
 * Converts a PrefixedTable to Drizzle pgTable() source code.
 */
export function tableToDrizzle(table: PrefixedTable): string {
	const lines: string[] = [];
	lines.push(
		`export const ${table.prefixedName} = pgTable("${table.prefixedName}", {`,
	);

	for (const [fieldName, field] of Object.entries(table.fields)) {
		lines.push(`\t${fieldName}: ${fieldToDrizzleColumn(fieldName, field)},`);
	}

	lines.push("});");
	return lines.join("\n");
}

function fieldToDrizzleColumn(name: string, field: FieldDefinition): string {
	let col: string;

	switch (field.type) {
		case "string":
			col = `text("${name}")`;
			break;
		case "number":
			col = `integer("${name}")`;
			break;
		case "boolean":
			col = `boolean("${name}")`;
			break;
		case "date":
			col = `timestamp("${name}")`;
			break;
		case "json":
			col = `json("${name}")`;
			break;
		default:
			col = `text("${name}")`;
	}

	if (field.primaryKey) col += ".primaryKey()";
	if (field.required) col += ".notNull()";
	if (field.unique) col += ".unique()";
	if (field.defaultValue !== undefined) {
		col += `.default(${JSON.stringify(field.defaultValue)})`;
	}

	return col;
}
