import { describe, expect, test } from "bun:test";
import type { PrefixedTable } from "../../db/schema";
import { generateDrizzleSchema } from "./drizzle";

describe("generateDrizzleSchema", () => {
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
					metadata: { type: "json" },
					created_at: { type: "date", required: true },
				},
			},
		],
	]);

	test("generates pg schema with correct imports", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "pg",
		});

		expect(result.code).toContain('from "drizzle-orm/pg-core"');
		expect(result.code).toContain("pgTable");
		expect(result.code).toContain("text");
		expect(result.code).toContain("integer");
		expect(result.code).toContain("jsonb");
		expect(result.code).toContain("timestamp");
		expect(result.code).toContain('export const billing_invoices = pgTable("billing_invoices"');
		expect(result.fileName).toBe("./futonic-schema.ts");
	});

	test("generates sqlite schema", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "sqlite",
		});

		expect(result.code).toContain('from "drizzle-orm/sqlite-core"');
		expect(result.code).toContain("sqliteTable");
		expect(result.code).toContain('mode: "json"');
	});

	test("generates mysql schema with varchar for unique fields", async () => {
		const tablesWithUnique = new Map<string, PrefixedTable>([
			[
				"auth_users",
				{
					originalName: "users",
					prefixedName: "auth_users",
					serviceId: "auth",
					fields: {
						id: { type: "string", primaryKey: true, required: true },
						email: { type: "string", unique: true, required: true },
					},
				},
			],
		]);

		const result = await generateDrizzleSchema({
			tables: tablesWithUnique,
			provider: "mysql",
		});

		expect(result.code).toContain('from "drizzle-orm/mysql-core"');
		expect(result.code).toContain("mysqlTable");
		expect(result.code).toContain('varchar("email", { length: 255 })');
	});

	test("respects custom output path", async () => {
		const result = await generateDrizzleSchema({
			tables,
			provider: "pg",
			file: "./custom/schema.ts",
		});

		expect(result.fileName).toBe("./custom/schema.ts");
	});
});
