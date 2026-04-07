import { describe, expect, test } from "bun:test";
import { tableToSQL } from "./kysely";

describe("tableToSQL", () => {
	test("generates CREATE TABLE statement", () => {
		const sql = tableToSQL({
			originalName: "invoices",
			prefixedName: "billing_invoices",
			serviceId: "billing",
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				amount: { type: "number", required: true },
				status: { type: "string" },
				created_at: { type: "date", required: true },
			},
		});

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS billing_invoices");
		expect(sql).toContain("id TEXT PRIMARY KEY NOT NULL");
		expect(sql).toContain("amount INTEGER NOT NULL");
		expect(sql).toContain("status TEXT");
		expect(sql).toContain("created_at TIMESTAMP NOT NULL");
	});

	test("generates foreign key constraints", () => {
		const sql = tableToSQL({
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
		});

		expect(sql).toContain("FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE");
	});
});
