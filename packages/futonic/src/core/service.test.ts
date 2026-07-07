import { describe, expect, test } from "bun:test";
import { createService } from "./service";

describe("createService", () => {
	test("returns a factory that produces a runnable service", () => {
		const factory = createService({
			id: "billing",
			version: "0.1.0",
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
			endpoints: () => ({}),
		});

		const svc = factory({} as any);

		expect(svc.id).toBe("billing");
		expect(svc.version).toBe("0.1.0");
		expect(typeof svc.createHandler).toBe("function");
	});
});
