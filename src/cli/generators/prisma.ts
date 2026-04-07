/**
 * Prisma schema generator.
 *
 * Forked from better-auth `packages/cli/src/generators/prisma.ts` (MIT).
 * Adapted to read from futonic's PrefixedTable IR instead of getAuthTables().
 * Uses @mrleebo/prisma-ast for AST-based schema patching.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FieldDefinition, PrefixedTable } from "../../db/schema";
import type { SchemaGenerator } from "./types";

type PrismaProvider = "sqlite" | "postgresql" | "mysql";

export const generatePrismaSchema: SchemaGenerator = async ({
	tables,
	provider: dbProvider,
	file,
}) => {
	const provider: PrismaProvider =
		dbProvider === "pg" ? "postgresql" : dbProvider === "mysql" ? "mysql" : "sqlite";

	const filePath = file || "./prisma/schema.prisma";
	const schemaExists = existsSync(path.resolve(filePath));

	// Dynamically import prisma-ast (optional dependency)
	let produceSchema: typeof import("@mrleebo/prisma-ast").produceSchema;
	try {
		({ produceSchema } = await import("@mrleebo/prisma-ast"));
	} catch {
		throw new Error(
			"@mrleebo/prisma-ast is required for Prisma schema generation. " +
				"Install it with: npm install @mrleebo/prisma-ast",
		);
	}

	let schemaPrisma = "";
	if (schemaExists) {
		schemaPrisma = await readFile(path.resolve(filePath), "utf-8");
	} else {
		schemaPrisma = getNewPrisma(provider);
	}

	const schema = produceSchema(schemaPrisma, (builder) => {
		for (const [, table] of tables) {
			const modelName = toPascalCase(table.prefixedName);

			const prismaModel = builder.findByType("model", {
				name: modelName,
			});

			// Create model with id field if it doesn't exist
			if (!prismaModel) {
				builder.model(modelName).field("id", "String").attribute("id");
			}

			for (const [fieldName, field] of Object.entries(table.fields)) {
				if (fieldName === "id") continue; // already handled above

				// Skip if field already exists in existing model
				if (prismaModel) {
					const existing = builder.findByType("field", {
						name: fieldName,
						within: prismaModel.properties,
					});
					if (existing) continue;
				}

				const prismaType = getPrismaType(field, provider);
				const fieldBuilder = builder.model(modelName).field(fieldName, prismaType);

				if (field.primaryKey) {
					fieldBuilder.attribute("id");
				}

				if (field.unique) {
					builder.model(modelName).blockAttribute(`unique([${fieldName}])`);
				}

				if (field.defaultValue !== undefined && field.defaultValue !== null) {
					if (typeof field.defaultValue === "string") {
						fieldBuilder.attribute(`default("${field.defaultValue}")`);
					} else if (
						typeof field.defaultValue === "boolean" ||
						typeof field.defaultValue === "number"
					) {
						fieldBuilder.attribute(`default(${field.defaultValue})`);
					}
				}

				if (field.references) {
					const refModelName = toPascalCase(field.references.model);
					let action = "Cascade";
					if (field.references.onDelete === "restrict") action = "Restrict";
					else if (field.references.onDelete === "set-null") action = "SetNull";

					const relationAttr = `relation(fields: [${fieldName}], references: [${field.references.field}], onDelete: ${action})`;
					builder
						.model(modelName)
						.field(
							field.references.model.toLowerCase(),
							`${refModelName}${field.required ? "" : "?"}`,
						)
						.attribute(relationAttr);
				}

				// MySQL text fields need @db.Text attribute
				if (
					provider === "mysql" &&
					field.type === "string" &&
					!field.unique &&
					!field.references
				) {
					fieldBuilder.attribute("db.Text");
				}
			}

			// Add @@map to map PascalCase model to snake_case table name
			const hasMapAttr = builder.findByType("attribute", {
				name: "map",
				within: prismaModel?.properties,
			});
			if (!hasMapAttr) {
				builder.model(modelName).blockAttribute("map", table.prefixedName);
			}
		}
	});

	const schemaChanged = schema.trim() !== schemaPrisma.trim();

	return {
		code: schemaChanged ? schema : "",
		fileName: filePath,
		overwrite: schemaExists && schemaChanged,
	};
};

/**
 * Maps a field definition to its Prisma type string.
 * Forked from better-auth's getType pattern.
 */
function getPrismaType(field: FieldDefinition, provider: PrismaProvider): string {
	const optional = !field.required && !field.primaryKey ? "?" : "";

	switch (field.type) {
		case "string":
			return `String${optional}`;
		case "number":
			return `Int${optional}`;
		case "boolean":
			return `Boolean${optional}`;
		case "date":
			return `DateTime${optional}`;
		case "json":
			// SQLite and MySQL don't natively support Json in Prisma
			if (provider === "sqlite" || provider === "mysql") {
				return `String${optional}`;
			}
			return `Json${optional}`;
		default:
			return `String${optional}`;
	}
}

function toPascalCase(str: string): string {
	return str
		.split("_")
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");
}

/**
 * Generates a fresh Prisma schema with generator and datasource blocks.
 * Forked from better-auth's getNewPrisma.
 */
function getNewPrisma(provider: PrismaProvider): string {
	return `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = ${provider === "sqlite" ? `"file:./dev.db"` : `env("DATABASE_URL")`}
}`;
}
