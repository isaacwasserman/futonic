import { describe, expect, test } from "bun:test";
import { tableToSQL } from "./kysely";

describe("tableToSQL", () => {
	test("generates CREATE TABLE statement for pg", () => {
		const sql = tableToSQL(
			{
				originalName: "invoices",
				prefixedName: "billing_invoices",
				serviceId: "billing",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					amount: { type: "number", required: true },
					status: { type: "string" },
					created_at: { type: "date", required: true },
				},
			},
			"pg",
		);

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS billing_invoices");
		expect(sql).toContain("id TEXT PRIMARY KEY NOT NULL");
		expect(sql).toContain("amount INTEGER NOT NULL");
		expect(sql).toContain("status TEXT");
		expect(sql).toContain("created_at TIMESTAMP NOT NULL");
	});

	test("generates sqlite-specific types", () => {
		const sql = tableToSQL(
			{
				originalName: "events",
				prefixedName: "analytics_events",
				serviceId: "analytics",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					is_active: { type: "boolean", required: true },
					happened_at: { type: "date", required: true },
					metadata: { type: "json" },
				},
			},
			"sqlite",
		);

		expect(sql).toContain("is_active INTEGER NOT NULL");
		expect(sql).toContain("happened_at INTEGER NOT NULL");
		expect(sql).toContain("metadata TEXT");
	});

	test("generates mysql-specific types", () => {
		const sql = tableToSQL(
			{
				originalName: "users",
				prefixedName: "auth_users",
				serviceId: "auth",
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					email: { type: "string", unique: true, required: true },
					data: { type: "json" },
				},
			},
			"mysql",
		);

		expect(sql).toContain("id TEXT PRIMARY KEY NOT NULL");
		expect(sql).toContain("email VARCHAR(255) NOT NULL UNIQUE");
		expect(sql).toContain("data JSON");
	});

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
						references: {
							model: "user",
							field: "id",
							onDelete: "cascade",
						},
					},
				},
			},
			"pg",
		);

		expect(sql).toContain(
			"FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE",
		);
	});
});
