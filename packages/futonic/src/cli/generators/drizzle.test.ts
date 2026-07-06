/**
 * Drizzle schema generator tests.
 *
 * Follows better-auth's pattern of snapshot-based testing
 * (packages/cli/test/generate-all-db.test.ts) — generates schema output
 * for each provider and compares against stored snapshots.
 */

import { describe, expect, test } from "bun:test";
import type { PrefixedTable } from "../../db/schema";
import { generateDrizzleSchema } from "./drizzle";

// A representative schema with multiple field types, constraints, and references
const tables = new Map<string, PrefixedTable>([
	[
		"billing_invoices",
		{
			originalName: "invoices",
			prefixedName: "billing_invoices",
			serviceId: "billing",
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				amount: { type: "number", required: true },
				status: {
					type: "string",
					enum: ["draft", "sent", "paid"],
				},
				is_recurring: { type: "boolean" },
				metadata: { type: "json" },
				created_at: { type: "date", required: true },
				user_id: {
					type: "string",
					required: true,
					references: { model: "user", field: "id", onDelete: "cascade" },
				},
			},
		},
	],
	[
		"billing_line_items",
		{
			originalName: "line_items",
			prefixedName: "billing_line_items",
			serviceId: "billing",
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				invoice_id: {
					type: "string",
					required: true,
					references: {
						model: "invoices",
						field: "id",
						onDelete: "cascade",
					},
				},
				description: { type: "string", required: true },
				amount: { type: "number", required: true },
				email: { type: "string", unique: true, required: true },
			},
		},
	],
]);

describe("generateDrizzleSchema", () => {
	test("generates correct pg schema", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "pg",
		});
		expect(result.code).toMatchSnapshot();
		expect(result.fileName).toBe("./futonic-schema.ts");
	});

	test("generates correct mysql schema", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "mysql",
		});
		expect(result.code).toMatchSnapshot();
	});

	test("generates correct sqlite schema", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "sqlite",
		});
		expect(result.code).toMatchSnapshot();
	});

	test("respects custom output path", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "pg",
			file: "./custom/schema.ts",
		});
		expect(result.fileName).toBe("./custom/schema.ts");
	});

	test("handles empty table set", async () => {
		const result = await generateDrizzleSchema({
			tables: new Map(),
			provider: "pg",
		});
		expect(result.code).toMatchSnapshot();
	});
});
