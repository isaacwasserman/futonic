/**
 * Drizzle ORM schema generator.
 *
 * Forked from better-auth `packages/cli/src/generators/drizzle.ts` (MIT).
 * Adapted to read from futonic's PrefixedTable IR instead of getAuthTables().
 * Generates pgTable/mysqlTable/sqliteTable definitions with column types,
 * constraints, references, and indexes.
 */

import type { FieldDefinition, PrefixedTable } from "../../db/schema";
import type {
	DatabaseProvider,
	GeneratorOptions,
	SchemaGenerator,
} from "./types";

export const generateDrizzleSchema: SchemaGenerator = async ({
	tables,
	provider,
	file,
}) => {
	const filePath = file || "./futonic-schema.ts";

	let code = generateImport({ provider, tables });

	for (const [, table] of tables) {
		code += `\n${generateTable(table, provider)}\n`;
	}

	return {
		code,
		fileName: filePath,
	};
};

/**
 * Generates a single Drizzle table definition.
 * Follows better-auth's pattern of mapping field types per provider.
 */
function generateTable(table: PrefixedTable, provider: DatabaseProvider): string {
	const tableFunc = `${provider}Table`;
	const fields = table.fields;

	type Index = { type: "uniqueIndex" | "index"; name: string; on: string };
	const indexes: Index[] = [];

	// Build column definitions
	const columnDefs = Object.entries(fields)
		.map(([fieldName, field]) => {
			let col = getColumnType(fieldName, field, provider);

			if (field.primaryKey) {
				col += ".primaryKey()";
			}

			if (
				field.defaultValue !== null &&
				field.defaultValue !== undefined
			) {
				if (typeof field.defaultValue === "string") {
					col += `.default("${field.defaultValue}")`;
				} else {
					col += `.default(${field.defaultValue})`;
				}
			}

			if (field.required) {
				col += ".notNull()";
			}

			if (field.unique) {
				col += ".unique()";
				indexes.push({
					type: "uniqueIndex",
					name: `${table.prefixedName}_${fieldName}_uidx`,
					on: fieldName,
				});
			}

			if (field.references) {
				const onDelete = field.references.onDelete || "cascade";
				const action =
					onDelete === "set-null" ? "set null" : onDelete;
				col += `.references(() => ${field.references.model}.${field.references.field}, { onDelete: '${action}' })`;
			}

			return `  ${fieldName}: ${col}`;
		})
		.join(",\n");

	const indexBlock = assignIndexes(indexes);

	return `export const ${table.prefixedName} = ${tableFunc}("${table.prefixedName}", {\n${columnDefs}\n}${indexBlock});`;
}

/**
 * Maps a field type + provider to the appropriate Drizzle column call.
 * Forked from better-auth's typeMap pattern.
 */
function getColumnType(
	name: string,
	field: FieldDefinition,
	provider: DatabaseProvider,
): string {
	// Handle enum fields
	if (field.enum && field.enum.length > 0) {
		const enumValues = field.enum.map((v) => `'${v}'`).join(", ");
		const typeMap: Record<DatabaseProvider, string> = {
			sqlite: `text("${name}")`,
			pg: `text("${name}", { enum: [${enumValues}] })`,
			mysql: `mysqlEnum("${name}", [${enumValues}])`,
		};
		return typeMap[provider];
	}

	const typeMap: Record<string, Record<DatabaseProvider, string>> = {
		string: {
			sqlite: `text("${name}")`,
			pg: `text("${name}")`,
			mysql: field.unique
				? `varchar("${name}", { length: 255 })`
				: field.references
					? `varchar("${name}", { length: 36 })`
					: `text("${name}")`,
		},
		boolean: {
			sqlite: `integer("${name}", { mode: 'boolean' })`,
			pg: `boolean("${name}")`,
			mysql: `boolean("${name}")`,
		},
		number: {
			sqlite: `integer("${name}")`,
			pg: `integer("${name}")`,
			mysql: `int("${name}")`,
		},
		date: {
			sqlite: `integer("${name}", { mode: 'timestamp_ms' })`,
			pg: `timestamp("${name}")`,
			mysql: `timestamp("${name}", { fsp: 3 })`,
		},
		json: {
			sqlite: `text("${name}", { mode: "json" })`,
			pg: `jsonb("${name}")`,
			mysql: `json("${name}")`,
		},
	};

	const dbTypeMap = typeMap[field.type];
	if (!dbTypeMap) {
		throw new Error(
			`Unsupported field type '${field.type}' for field '${name}'.`,
		);
	}
	return dbTypeMap[provider];
}

function assignIndexes(
	indexes: { type: "uniqueIndex" | "index"; name: string; on: string }[],
): string {
	if (!indexes.length) return "";

	const lines = [", (table) => ["];
	for (const index of indexes) {
		lines.push(`  ${index.type}("${index.name}").on(table.${index.on}),`);
	}
	lines.push("]");
	return lines.join("\n");
}

/**
 * Generates the import block for the Drizzle schema file.
 * Forked from better-auth's generateImport pattern — only includes
 * imports for types actually used.
 */
function generateImport({
	provider,
	tables,
}: {
	provider: DatabaseProvider;
	tables: Map<string, PrefixedTable>;
}) {
	const coreImports: string[] = [`${provider}Table`];

	let hasJson = false;
	let hasDate = false;
	let hasBoolean = false;
	let hasNumber = false;
	let hasEnum = false;

	for (const [, table] of tables) {
		for (const field of Object.values(table.fields)) {
			if (field.type === "json") hasJson = true;
			if (field.type === "date") hasDate = true;
			if (field.type === "boolean") hasBoolean = true;
			if (field.type === "number") hasNumber = true;
			if (field.enum && field.enum.length > 0) hasEnum = true;
		}
	}

	// Text is always needed
	if (provider === "mysql") {
		coreImports.push("varchar", "text");
	} else {
		coreImports.push("text");
	}

	if (hasNumber) {
		if (provider === "mysql") coreImports.push("int");
		else coreImports.push("integer");
	}

	if (hasBoolean && provider !== "sqlite") {
		coreImports.push("boolean");
	} else if (hasBoolean) {
		// sqlite uses integer for boolean, already imported if hasNumber
		if (!hasNumber) coreImports.push("integer");
	}

	if (hasDate && provider !== "sqlite") {
		coreImports.push("timestamp");
	} else if (hasDate && !hasNumber && !hasBoolean) {
		// sqlite uses integer for timestamps
		coreImports.push("integer");
	}

	if (hasJson) {
		if (provider === "pg") coreImports.push("jsonb");
		if (provider === "mysql") coreImports.push("json");
		// sqlite uses text mode json — already imported
	}

	if (hasEnum && provider === "mysql") {
		coreImports.push("mysqlEnum");
	}

	const hasUniqueIdx = [...tables.values()].some((t) =>
		Object.values(t.fields).some((f) => f.unique),
	);
	if (hasUniqueIdx) {
		coreImports.push("uniqueIndex");
	}

	const dedupedImports = [...new Set(coreImports)];
	return `import { ${dedupedImports.join(", ")} } from "drizzle-orm/${provider}-core";\n`;
}
