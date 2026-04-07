import { describe, expect, test } from "bun:test";
import { createService } from "./service";

describe("createService", () => {
	test("returns a factory function that produces a MountedService", () => {
		const factory = createService({
			id: "billing",
			version: "0.1.0",
			dependencies: { database: true },
			dbSchema: {
				tables: {
					invoices: {
						fields: {
							id: { type: "string", primaryKey: true, required: true },
							amount: { type: "number", required: true },
						},
					},
				},
			},
			endpoints: {},
		});

		const mounted = factory({ mount: "/api/billing" });

		expect(mounted.id).toBe("billing");
		expect(mounted.version).toBe("0.1.0");
		expect(mounted.mountConfig.mount).toBe("/api/billing");
		expect(mounted.dependencies.database).toBe(true);
		expect(mounted.dbSchema?.tables.invoices).toBeDefined();
	});
});
