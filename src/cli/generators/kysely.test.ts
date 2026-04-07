/**
 * SQL DDL generator tests.
 *
 * Follows better-auth's snapshot-based test pattern.
 */

import { describe, expect, test } from "bun:test";
import type { PrefixedTable } from "../../db/schema";
import { generateKyselySchema, tableToSQL } from "./kysely";

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
				is_active: { type: "boolean", required: true },
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
]);

describe("generateKyselySchema", () => {
	test("generates correct pg DDL", async () => {
		const result = await generateKyselySchema({ tables, provider: "pg" });
		expect(result.code).toMatchSnapshot();
	});

	test("generates correct mysql DDL", async () => {
		const result = await generateKyselySchema({ tables, provider: "mysql" });
		expect(result.code).toMatchSnapshot();
	});

	test("generates correct sqlite DDL", async () => {
		const result = await generateKyselySchema({ tables, provider: "sqlite" });
		expect(result.code).toMatchSnapshot();
	});

	test("generates timestamped filename by default", async () => {
		const result = await generateKyselySchema({ tables, provider: "pg" });
		expect(result.fileName).toMatch(/^\.\/futonic_migrations\/.*\.sql$/);
	});

	test("respects custom output path", async () => {
		const result = await generateKyselySchema({
			tables,
			provider: "pg",
			file: "./migrations/001.sql",
		});
		expect(result.fileName).toBe("./migrations/001.sql");
	});
});

describe("tableToSQL", () => {
	test("generates foreign key constraints", () => {
		const sql = tableToSQL(
			{
				originalName: "invoices",
				prefixedName: "billing_invoices",
				serviceId: "billing",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					user_id: {
						type: "string",
						required: true,
						references: { model: "user", field: "id", onDelete: "cascade" },
					},
				},
			},
			"pg",
		);
		expect(sql).toContain(
			"FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE",
		);
	});

	test("handles default values", () => {
		const sql = tableToSQL(
			{
				originalName: "config",
				prefixedName: "app_config",
				serviceId: "app",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					retries: { type: "number", required: true, defaultValue: 3 },
					label: { type: "string", defaultValue: "default" },
				},
			},
			"pg",
		);
		expect(sql).toContain("DEFAULT 3");
		expect(sql).toContain("DEFAULT 'default'");
	});

	test("unique constraint on field", () => {
		const sql = tableToSQL(
			{
				originalName: "users",
				prefixedName: "auth_users",
				serviceId: "auth",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					email: { type: "string", unique: true, required: true },
				},
			},
			"mysql",
		);
		expect(sql).toContain("email VARCHAR(255) NOT NULL UNIQUE");
	});
});
