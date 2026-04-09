/**
 * Tests for the CLI factory.
 *
 * We don't test process.argv parsing (that's just string matching),
 * but we do test the core pipeline: service definition → table collection
 * → generator output. This is the same pipeline createCLI drives.
 */

import { describe, expect, test } from "bun:test";
import type { EmbeddableService } from "../core/service";
import { getServiceTables } from "../db/schema";
import { generateDrizzleSchema } from "./generators/drizzle";
import { generateKyselySchema } from "./generators/kysely";

const billingService: EmbeddableService = {
	id: "billing",
	version: "0.1.0",
	dependencies: { database: true },
	dbSchema: {
		tables: {
			invoices: {
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					amount: { type: "number", required: true },
					status: { type: "string", required: true },
				},
			},
			line_items: {
				fields: {
					id: { type: "string", primaryKey: true, required: true },
					invoice_id: {
						type: "string",
						required: true,
						references: {
							model: "billing_invoices",
							field: "id",
							onDelete: "cascade",
						},
					},
					amount: { type: "number", required: true },
				},
			},
		},
	},
	endpoints: {},
};

describe("CLI pipeline: service → tables → generator", () => {
	test("getServiceTables correctly prefixes a service's schema", () => {
		const tables = getServiceTables([
			{ ...billingService, mountConfig: { mount: "" } },
		]);

		expect(tables.size).toBe(2);
		expect(tables.has("billing_invoices")).toBe(true);
		expect(tables.has("billing_line_items")).toBe(true);

		const invoices = tables.get("billing_invoices")!;
		expect(invoices.originalName).toBe("invoices");
		expect(invoices.serviceId).toBe("billing");
	});

	test("full pipeline produces valid Drizzle schema", async () => {
		const tables = getServiceTables([
			{ ...billingService, mountConfig: { mount: "" } },
		]);

		const result = await generateDrizzleSchema({
			tables,
			provider: "pg",
		});

		expect(result.code).toContain("billing_invoices");
		expect(result.code).toContain("billing_line_items");
		expect(result.code).toContain("pgTable");
		expect(result.code).toContain(".references(() => billing_invoices.id");
	});

	test("full pipeline produces valid SQL DDL", async () => {
		const tables = getServiceTables([
			{ ...billingService, mountConfig: { mount: "" } },
		]);

		const result = await generateKyselySchema({
			tables,
			provider: "pg",
		});

		expect(result.code).toContain(
			"CREATE TABLE IF NOT EXISTS billing_invoices",
		);
		expect(result.code).toContain(
			"CREATE TABLE IF NOT EXISTS billing_line_items",
		);
		expect(result.code).toContain(
			"FOREIGN KEY (invoice_id) REFERENCES billing_invoices(id)",
		);
	});

	test("service without database produces no tables", () => {
		const noDB: EmbeddableService = {
			id: "analytics",
			version: "0.1.0",
			dependencies: { database: false },
			endpoints: {},
		};

		const tables = getServiceTables([{ ...noDB, mountConfig: { mount: "" } }]);
		expect(tables.size).toBe(0);
	});
});
