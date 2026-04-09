import { describe, expect, test } from "bun:test";
import type { MountedService } from "../core/service";
import { getServiceTables, prefixTableName } from "./schema";

describe("prefixTableName", () => {
	test("prefixes table name with service id", () => {
		expect(prefixTableName("billing", "invoices")).toBe("billing_invoices");
	});
});

describe("getServiceTables", () => {
	test("collects and prefixes tables from services", () => {
		const services = [
			{
				id: "billing",
				version: "0.1.0",
				dependencies: { database: true },
				dbSchema: {
					tables: {
						invoices: {
							fields: {
								id: {
									type: "string" as const,
									primaryKey: true,
									required: true,
								},
								amount: { type: "number" as const, required: true },
							},
						},
					},
				},
				endpoints: {},
				mountConfig: { mount: "/api/billing" },
			},
		] satisfies MountedService[];

		const tables = getServiceTables(services);
		expect(tables.size).toBe(1);
		expect(tables.has("billing_invoices")).toBe(true);

		const table = tables.get("billing_invoices")!;
		expect(table.originalName).toBe("invoices");
		expect(table.serviceId).toBe("billing");
		expect(table.fields.amount.type).toBe("number");
	});

	test("throws on table name collision", () => {
		const services = [
			{
				id: "billing",
				version: "0.1.0",
				dependencies: { database: true },
				dbSchema: { tables: { invoices: { fields: {} } } },
				endpoints: {},
				mountConfig: { mount: "/a" },
			},
			{
				id: "billing",
				version: "0.1.0",
				dependencies: { database: true },
				dbSchema: { tables: { invoices: { fields: {} } } },
				endpoints: {},
				mountConfig: { mount: "/b" },
			},
		] satisfies MountedService[];

		expect(() => getServiceTables(services)).toThrow("collision");
	});

	test("skips services without dbSchema", () => {
		const services = [
			{
				id: "analytics",
				version: "0.1.0",
				dependencies: { database: false },
				endpoints: {},
				mountConfig: { mount: "/api/analytics" },
			},
		] satisfies MountedService[];

		const tables = getServiceTables(services);
		expect(tables.size).toBe(0);
	});
});
