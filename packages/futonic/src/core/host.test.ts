import { describe, expect, test } from "bun:test";
import { createHost } from "./host";
import { createService } from "./service";

describe("createHost", () => {
	test("detects namespace collisions", () => {
		const factory = createService({
			id: "billing",
			version: "0.1.0",
			dependencies: { database: false },
			dbSchema: { tables: {} },
			endpoints: {},
		});

		expect(() =>
			createHost({
				services: [factory({ mount: "/a" }), factory({ mount: "/b" })],
			}),
		).toThrow("Namespace collision");
	});

	test("initializes services without database", async () => {
		let initCalled = false;
		let readyCalled = false;

		const factory = createService({
			id: "simple",
			version: "0.1.0",
			dependencies: { database: false },
			dbSchema: { tables: {} },
			endpoints: {},
			onInit: async () => {
				initCalled = true;
			},
			onReady: async () => {
				readyCalled = true;
			},
		});

		const host = createHost({
			services: [factory({ mount: "/api/simple" })],
		});

		await host.init();
		expect(initCalled).toBe(true);
		expect(readyCalled).toBe(true);
	});

	test("throws if service needs database but none provided", async () => {
		const factory = createService({
			id: "billing",
			version: "0.1.0",
			dependencies: { database: true },
			dbSchema: { tables: { invoices: { fields: {} } } },
			endpoints: {},
		});

		const host = createHost({
			services: [factory({ mount: "/api/billing" })],
		});

		expect(host.init()).rejects.toThrow("database");
	});
});
