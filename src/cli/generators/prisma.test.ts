/**
 * Prisma schema generator tests.
 *
 * Follows better-auth's snapshot-based test pattern
 * (packages/cli/test/generate.test.ts).
 */

import { describe, expect, test } from "bun:test";
import type { PrefixedTable } from "../../db/schema";
import { generatePrismaSchema } from "./prisma";

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
				status: { type: "string", required: true },
				is_active: { type: "boolean" },
				metadata: { type: "json" },
				created_at: { type: "date", required: true },
				email: { type: "string", unique: true, required: true },
				user_id: {
					type: "string",
					required: true,
					references: { model: "user", field: "id", onDelete: "cascade" },
				},
			},
		},
	],
]);

describe("generatePrismaSchema", () => {
	test("generates correct postgresql schema", async () => {
		const result = await generatePrismaSchema({
			tables,
			provider: "pg",
		});
		expect(result.code).toMatchSnapshot();
		expect(result.fileName).toBe("./prisma/schema.prisma");
	});

	test("generates correct mysql schema", async () => {
		const result = await generatePrismaSchema({
			tables,
			provider: "mysql",
		});
		expect(result.code).toMatchSnapshot();
	});

	test("generates correct sqlite schema", async () => {
		const result = await generatePrismaSchema({
			tables,
			provider: "sqlite",
		});
		expect(result.code).toMatchSnapshot();
	});

	test("generates model with @@map for prefixed table name", async () => {
		const result = await generatePrismaSchema({
			tables,
			provider: "pg",
		});
		expect(result.code).toContain('@@map("billing_invoices")');
	});

	test("handles default values", async () => {
		const tablesWithDefaults = new Map<string, PrefixedTable>([
			[
				"app_config",
				{
					originalName: "config",
					prefixedName: "app_config",
					serviceId: "app",
					fields: {
						id: { type: "string", primaryKey: true, required: true },
						retries: { type: "number", required: true, defaultValue: 3 },
						enabled: { type: "boolean", required: true, defaultValue: true },
						label: { type: "string", defaultValue: "default" },
					},
				},
			],
		]);

		const result = await generatePrismaSchema({
			tables: tablesWithDefaults,
			provider: "pg",
		});
		expect(result.code).toContain("@default(3)");
		expect(result.code).toContain("@default(true)");
		expect(result.code).toContain('@default("default")');
	});

	test("respects custom output path", async () => {
		const result = await generatePrismaSchema({
			tables,
			provider: "pg",
			file: "./custom/schema.prisma",
		});
		expect(result.fileName).toBe("./custom/schema.prisma");
	});
});
