import type { FieldDefinition, PrefixedTable } from "../../db/schema";

/**
 * Generates / patches a Prisma schema from the collected service tables.
 * Uses @mrleebo/prisma-ast for AST manipulation.
 * Forked from better-auth's CLI generator pattern.
 */
export async function generatePrismaSchema(outPath?: string) {
	const output = outPath ?? "schema.prisma";
	console.log(`[futonic] Prisma schema patching → ${output}`);
	console.log("[futonic] Not yet implemented — requires host config loading");
}

/**
 * Converts a PrefixedTable to a Prisma model string.
 */
export function tableToPrismaModel(table: PrefixedTable): string {
	const lines: string[] = [];
	const modelName = toPascalCase(table.prefixedName);

	lines.push(`model ${modelName} {`);
	lines.push(`\t@@map("${table.prefixedName}")`);

	for (const [fieldName, field] of Object.entries(table.fields)) {
		lines.push(`\t${fieldName} ${fieldToPrismaType(field)}`);
	}

	lines.push("}");
	return lines.join("\n");
}

function fieldToPrismaType(field: FieldDefinition): string {
	let type: string;

	switch (field.type) {
		case "string":
			type = "String";
			break;
		case "number":
			type = "Int";
			break;
		case "boolean":
			type = "Boolean";
			break;
		case "date":
			type = "DateTime";
			break;
		case "json":
			type = "Json";
			break;
		default:
			type = "String";
	}

	const modifiers: string[] = [];
	if (field.primaryKey) modifiers.push("@id");
	if (field.unique) modifiers.push("@unique");
	if (field.defaultValue !== undefined) {
		modifiers.push(`@default(${JSON.stringify(field.defaultValue)})`);
	}
	if (!field.required && !field.primaryKey) type += "?";

	return `${type} ${modifiers.join(" ")}`.trim();
}

function toPascalCase(str: string): string {
	return str
		.split("_")
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");
}
