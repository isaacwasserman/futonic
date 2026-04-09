/**
 * Framework-level tests for futonic's core contracts.
 *
 * These test the framework's guarantees — lifecycle ordering, context
 * isolation, adapter edge cases, error propagation — not any specific
 * service implementation.
 *
 * Every test creates its own in-memory SQLite via test-utils, so there
 * are no ordering dependencies between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEndpoint, createMiddleware, createRouter } from "better-call";
import type { ServiceContext } from "./core/context";
import { type Host, createHost } from "./core/host";
import { createService } from "./core/service";
import { createInternalAdapter } from "./db/internal-adapter";
import type { ServiceDBSchema } from "./db/schema";
import { createServiceMiddleware } from "./router/middleware";
import { type TestDatabase, createTestDatabase } from "./test-utils";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const simpleSchema = {
	tables: {
		items: {
			fields: {
				id: { type: "string" as const, primaryKey: true, required: true },
				name: { type: "string" as const, required: true },
				value: { type: "number" as const },
			},
		},
	},
} satisfies ServiceDBSchema;

const CREATE_ITEMS = `CREATE TABLE test_items (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	value INTEGER
)`;

const CREATE_ALPHA_ITEMS = `CREATE TABLE alpha_items (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	value INTEGER
)`;

const CREATE_BETA_ITEMS = `CREATE TABLE beta_items (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	value INTEGER
)`;

// ---------------------------------------------------------------------------
// 1. Lifecycle ordering
// ---------------------------------------------------------------------------

describe("lifecycle ordering", () => {
	test("onInit fires before onReady for a single service", async () => {
		const order: string[] = [];

		const svc = createService({
			id: "a",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				order.push("init");
			},
			onReady: async () => {
				order.push("ready");
			},
		});

		const host = createHost({ services: [svc({ mount: "/a" })] });
		await host.init();

		expect(order).toEqual(["init", "ready"]);
		await host.shutdown();
	});

	test("ALL onInit calls complete before ANY onReady fires", async () => {
		const order: string[] = [];

		const svcA = createService({
			id: "a",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				// Simulate slow init
				await new Promise((r) => setTimeout(r, 20));
				order.push("a:init");
			},
			onReady: async () => {
				order.push("a:ready");
			},
		});

		const svcB = createService({
			id: "b",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				order.push("b:init");
			},
			onReady: async () => {
				order.push("b:ready");
			},
		});

		const host = createHost({
			services: [svcA({ mount: "/a" }), svcB({ mount: "/b" })],
		});

		await host.init();

		// All inits must come before all readys
		const firstReady = order.indexOf("a:ready");
		const lastInit = Math.max(order.indexOf("a:init"), order.indexOf("b:init"));
		expect(lastInit).toBeLessThan(firstReady);

		expect(order).toEqual(["a:init", "b:init", "a:ready", "b:ready"]);
		await host.shutdown();
	});

	test("onShutdown fires for all services", async () => {
		const shutdowns: string[] = [];

		const svcA = createService({
			id: "a",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onShutdown: async () => {
				shutdowns.push("a");
			},
		});

		const svcB = createService({
			id: "b",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onShutdown: async () => {
				shutdowns.push("b");
			},
		});

		const host = createHost({
			services: [svcA({ mount: "/a" }), svcB({ mount: "/b" })],
		});
		await host.init();
		await host.shutdown();

		expect(shutdowns).toEqual(["a", "b"]);
	});

	test("services without lifecycle hooks don't break init", async () => {
		const svc = createService({
			id: "bare",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			// no onInit, onReady, onShutdown
		});

		const host = createHost({ services: [svc({ mount: "/bare" })] });
		await host.init();
		await host.shutdown();
		// No error = pass
	});
});

// ---------------------------------------------------------------------------
// 2. Lifecycle error propagation
// ---------------------------------------------------------------------------

describe("lifecycle error propagation", () => {
	test("onInit throwing rejects host.init()", async () => {
		const svc = createService({
			id: "broken",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				throw new Error("init boom");
			},
		});

		const host = createHost({ services: [svc({ mount: "/x" })] });
		await expect(host.init()).rejects.toThrow("init boom");
	});

	test("onReady throwing rejects host.init()", async () => {
		const svc = createService({
			id: "broken-ready",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onReady: async () => {
				throw new Error("ready boom");
			},
		});

		const host = createHost({ services: [svc({ mount: "/x" })] });
		await expect(host.init()).rejects.toThrow("ready boom");
	});

	test("if first service's onInit throws, second service's onInit does NOT run", async () => {
		let secondInitRan = false;

		const svcA = createService({
			id: "a",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				throw new Error("a exploded");
			},
		});

		const svcB = createService({
			id: "b",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async () => {
				secondInitRan = true;
			},
		});

		const host = createHost({
			services: [svcA({ mount: "/a" }), svcB({ mount: "/b" })],
		});
		await expect(host.init()).rejects.toThrow("a exploded");
		expect(secondInitRan).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. Multi-service context isolation
// ---------------------------------------------------------------------------

describe("service context isolation", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(CREATE_ALPHA_ITEMS);
		db.run(CREATE_BETA_ITEMS);
	});

	afterEach(async () => {
		await db.close();
	});

	test("each service receives its own ServiceContext", async () => {
		const contexts: ServiceContext[] = [];

		const svcA = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
			onInit: async (ctx) => {
				contexts.push(ctx);
			},
		});

		const svcB = createService({
			id: "beta",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
			onInit: async (ctx) => {
				contexts.push(ctx);
			},
		});

		const host = createHost({
			database: db.raw,
			baseURL: "http://localhost:3000",
			services: [svcA({ mount: "/api/alpha" }), svcB({ mount: "/api/beta" })],
		});

		await host.init();

		expect(contexts).toHaveLength(2);

		// Different context objects
		expect(contexts[0]).not.toBe(contexts[1]);

		// Different adapters (different table prefixes)
		expect(contexts[0].db).not.toBe(contexts[1].db);

		// Correct mount paths
		expect(contexts[0].hostInfo.mountPath).toBe("/api/alpha");
		expect(contexts[1].hostInfo.mountPath).toBe("/api/beta");

		// Same baseURL
		expect(contexts[0].hostInfo.baseURL).toBe("http://localhost:3000");
		expect(contexts[1].hostInfo.baseURL).toBe("http://localhost:3000");

		await host.shutdown();
	});

	test("service config is correctly passed through", async () => {
		let capturedConfig: Record<string, unknown> = {};

		const svc = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async (ctx) => {
				capturedConfig = ctx.config;
			},
		});

		const host = createHost({
			services: [
				svc({
					mount: "/api/alpha",
					config: { apiKey: "secret-123", maxRetries: 3 },
				}),
			],
		});

		await host.init();

		expect(capturedConfig).toEqual({ apiKey: "secret-123", maxRetries: 3 });
		await host.shutdown();
	});

	test("data written by one service is invisible to another", async () => {
		const svcA = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const svcB = createService({
			id: "beta",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const host = createHost({
			database: db.raw,
			services: [svcA({ mount: "/api/alpha" }), svcB({ mount: "/api/beta" })],
		});

		await host.init();

		const ctxA = host.services.get("alpha")?.serviceContext!;
		const ctxB = host.services.get("beta")?.serviceContext!;

		// Write to alpha
		await ctxA.db.items.create({ id: "a1", name: "alpha-only", value: 1 });

		// Beta sees nothing
		const betaItems = await ctxB.db.items.findMany();
		expect(betaItems).toHaveLength(0);

		// Alpha sees its own data
		const alphaItems = await ctxA.db.items.findMany();
		expect(alphaItems).toHaveLength(1);

		// Write to beta
		await ctxB.db.items.create({ id: "b1", name: "beta-only", value: 2 });

		// Each sees only their own
		expect(await ctxA.db.items.count()).toBe(1);
		expect(await ctxB.db.items.count()).toBe(1);

		await host.shutdown();
	});

	test("accessing a table not in schema throws", async () => {
		const svc = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const host = createHost({
			database: db.raw,
			services: [svc({ mount: "/x" })],
		});

		await host.init();

		const ctx = host.services.get("alpha")?.serviceContext!;
		expect(() => (ctx.db as any).nonexistent).toThrow(
			'does not have a table named "nonexistent"',
		);

		await host.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 4. InternalAdapter edge cases
// ---------------------------------------------------------------------------

describe("InternalAdapter edge cases", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(CREATE_ITEMS);
	});

	afterEach(async () => {
		await db.close();
	});

	function adapter() {
		return createInternalAdapter(db.kysely, "test", simpleSchema);
	}

	// -- Empty table --

	test("findMany on empty table returns empty array", async () => {
		const items = await adapter().items.findMany();
		expect(items).toEqual([]);
	});

	test("findOne on empty table returns null", async () => {
		const item = await adapter().items.findOne([
			{ field: "id", value: "nope" },
		]);
		expect(item).toBeNull();
	});

	test("count on empty table returns 0", async () => {
		expect(await adapter().items.count()).toBe(0);
	});

	test("deleteMany on empty table returns 0", async () => {
		const count = await adapter().items.deleteMany([
			{ field: "name", value: "nonexistent" },
		]);
		expect(count).toBe(0);
	});

	test("updateMany on empty table returns 0", async () => {
		const count = await adapter().items.updateMany(
			[{ field: "id", value: "nope" }],
			{ name: "new" },
		);
		expect(count).toBe(0);
	});

	// -- Null values --

	test("create with null optional field", async () => {
		const item = await adapter().items.create({
			id: "n1",
			name: "nullable",
			value: null,
		});
		expect(item.value).toBeNull();
	});

	test("findOne with eq null (WHERE field IS NULL)", async () => {
		await adapter().items.create({ id: "n1", name: "null-val", value: null });
		await adapter().items.create({ id: "n2", name: "has-val", value: 42 });

		const found = await adapter().items.findOne([
			{ field: "value", value: null, operator: "eq" },
		]);
		expect(found).not.toBeNull();
		expect(found?.id).toBe("n1");
	});

	test("findMany with ne null (WHERE field IS NOT NULL)", async () => {
		await adapter().items.create({ id: "n1", name: "null-val", value: null });
		await adapter().items.create({ id: "n2", name: "has-val", value: 42 });

		const found = await adapter().items.findMany({
			where: [{ field: "value", value: null, operator: "ne" }],
		});
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe("n2");
	});

	// -- All WHERE operators --

	describe("WHERE operators", () => {
		beforeEach(async () => {
			const a = adapter();
			await a.items.create({ id: "1", name: "a", value: 10 });
			await a.items.create({ id: "2", name: "b", value: 20 });
			await a.items.create({ id: "3", name: "c", value: 30 });
			await a.items.create({ id: "4", name: "d", value: 40 });
		});

		test("eq", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 20 }],
			});
			expect(found).toHaveLength(1);
			expect(found[0]?.id).toBe("2");
		});

		test("ne", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 20, operator: "ne" }],
			});
			expect(found).toHaveLength(3);
		});

		test("gt", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 25, operator: "gt" }],
			});
			expect(found).toHaveLength(2); // 30, 40
		});

		test("gte", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 30, operator: "gte" }],
			});
			expect(found).toHaveLength(2); // 30, 40
		});

		test("lt", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 25, operator: "lt" }],
			});
			expect(found).toHaveLength(2); // 10, 20
		});

		test("lte", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "value", value: 20, operator: "lte" }],
			});
			expect(found).toHaveLength(2); // 10, 20
		});

		test("in", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "id", value: ["1", "3", "999"], operator: "in" }],
			});
			expect(found).toHaveLength(2);
			const ids = found.map((r) => r.id).sort();
			expect(ids).toEqual(["1", "3"]);
		});

		test("not_in", async () => {
			const found = await adapter().items.findMany({
				where: [{ field: "id", value: ["1", "3"], operator: "not_in" }],
			});
			expect(found).toHaveLength(2);
			const ids = found.map((r) => r.id).sort();
			expect(ids).toEqual(["2", "4"]);
		});

		test("compound WHERE (multiple conditions = AND)", async () => {
			const found = await adapter().items.findMany({
				where: [
					{ field: "value", value: 15, operator: "gte" },
					{ field: "value", value: 35, operator: "lte" },
				],
			});
			expect(found).toHaveLength(2); // 20, 30
			const values = found.map((r) => r.value).sort();
			expect(values).toEqual([20, 30]);
		});

		test("empty where array returns all rows", async () => {
			const found = await adapter().items.findMany({ where: [] });
			expect(found).toHaveLength(4);
		});
	});

	// -- Sorting and pagination --

	describe("sorting and pagination", () => {
		beforeEach(async () => {
			const a = adapter();
			await a.items.create({ id: "1", name: "c", value: 30 });
			await a.items.create({ id: "2", name: "a", value: 10 });
			await a.items.create({ id: "3", name: "b", value: 20 });
		});

		test("sortBy asc", async () => {
			const found = await adapter().items.findMany({
				sortBy: { field: "value", direction: "asc" },
			});
			expect(found.map((r) => r.value)).toEqual([10, 20, 30]);
		});

		test("sortBy desc", async () => {
			const found = await adapter().items.findMany({
				sortBy: { field: "value", direction: "desc" },
			});
			expect(found.map((r) => r.value)).toEqual([30, 20, 10]);
		});

		test("limit", async () => {
			const found = await adapter().items.findMany({
				sortBy: { field: "value", direction: "asc" },
				limit: 2,
			});
			expect(found).toHaveLength(2);
			expect(found.map((r) => r.value)).toEqual([10, 20]);
		});

		test("offset with limit", async () => {
			const found = await adapter().items.findMany({
				sortBy: { field: "value", direction: "asc" },
				limit: 2,
				offset: 1,
			});
			expect(found).toHaveLength(2);
			expect(found.map((r) => r.value)).toEqual([20, 30]);
		});

		test("offset beyond data returns empty", async () => {
			const found = await adapter().items.findMany({
				offset: 100,
				limit: 10,
			});
			expect(found).toEqual([]);
		});

		test("limit 0 returns empty", async () => {
			const found = await adapter().items.findMany({ limit: 0 });
			expect(found).toEqual([]);
		});
	});

	// -- update edge cases --

	test("update throws when row doesn't exist", async () => {
		await expect(
			adapter().items.update([{ field: "id", value: "nonexistent" }], {
				name: "new",
			}),
		).rejects.toThrow();
	});

	test("update only modifies matched row", async () => {
		const a = adapter();
		await a.items.create({ id: "1", name: "keep", value: 1 });
		await a.items.create({ id: "2", name: "change", value: 2 });

		await a.items.update([{ field: "id", value: "2" }], {
			name: "changed",
		});

		const row1 = await a.items.findOne([{ field: "id", value: "1" }]);
		const row2 = await a.items.findOne([{ field: "id", value: "2" }]);
		expect(row1?.name).toBe("keep");
		expect(row2?.name).toBe("changed");
	});

	// -- delete edge cases --

	test("delete on nonexistent row is a no-op", async () => {
		// Should not throw
		await adapter().items.delete([{ field: "id", value: "nope" }]);
	});

	// -- count with where --

	test("count with where returns filtered count", async () => {
		const a = adapter();
		await a.items.create({ id: "1", name: "x", value: 10 });
		await a.items.create({ id: "2", name: "y", value: 20 });
		await a.items.create({ id: "3", name: "x", value: 30 });

		expect(await a.items.count([{ field: "name", value: "x" }])).toBe(2);
		expect(
			await a.items.count([{ field: "value", value: 15, operator: "gt" }]),
		).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 5. Service factory behavior
// ---------------------------------------------------------------------------

describe("service factory", () => {
	test("same factory produces independent mounted instances", () => {
		const factory = createService({
			id: "svc",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
		});

		const a = factory({ mount: "/a", config: { key: "a" } });
		const b = factory({ mount: "/b", config: { key: "b" } });

		expect(a).not.toBe(b);
		expect(a.mountConfig.mount).toBe("/a");
		expect(b.mountConfig.mount).toBe("/b");
		expect(a.mountConfig.config).toEqual({ key: "a" });
		expect(b.mountConfig.config).toEqual({ key: "b" });

		// Same identity
		expect(a.id).toBe("svc");
		expect(b.id).toBe("svc");
	});

	test("mounted instance includes all definition fields", () => {
		let initRef: ((...args: unknown[]) => unknown) | undefined;
		const factory = createService({
			id: "full",
			version: "2.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: { fake: "endpoint" as any },
			onInit: async () => {},
			onReady: async () => {},
			onShutdown: async () => {},
		});

		const mounted = factory({ mount: "/full" });
		expect(mounted.id).toBe("full");
		expect(mounted.version).toBe("2.0.0");
		expect(mounted.dependencies.database).toBe(true);
		expect(mounted.dbSchema).toBe(simpleSchema);
		expect(mounted.endpoints).toEqual({ fake: "endpoint" });
		expect(mounted.onInit).toBeFunction();
		expect(mounted.onReady).toBeFunction();
		expect(mounted.onShutdown).toBeFunction();
	});
});

// ---------------------------------------------------------------------------
// 6. Concurrent database operations
// ---------------------------------------------------------------------------

describe("concurrent database operations", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(CREATE_ITEMS);
	});

	afterEach(async () => {
		await db.close();
	});

	test("parallel creates all persist", async () => {
		const a = createInternalAdapter(db.kysely, "test", simpleSchema);

		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				a.items.create({
					id: `item-${i}`,
					name: `name-${i}`,
					value: i,
				}),
			),
		);

		const count = await a.items.count();
		expect(count).toBe(20);

		const all = await a.items.findMany();
		expect(all).toHaveLength(20);
	});

	test("parallel reads return consistent data", async () => {
		const a = createInternalAdapter(db.kysely, "test", simpleSchema);

		// Seed data
		for (let i = 0; i < 10; i++) {
			await a.items.create({ id: `s-${i}`, name: `n-${i}`, value: i });
		}

		// Parallel reads
		const results = await Promise.all(
			Array.from({ length: 10 }, () => a.items.findMany()),
		);

		// All reads should return the same 10 items
		for (const result of results) {
			expect(result).toHaveLength(10);
		}
	});
});

// ---------------------------------------------------------------------------
// 7. Host services map
// ---------------------------------------------------------------------------

describe("host.services map", () => {
	test("is correctly populated after creation", () => {
		const svcA = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
		});

		const svcB = createService({
			id: "beta",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
		});

		const host = createHost({
			services: [svcA({ mount: "/a" }), svcB({ mount: "/b" })],
		});

		expect(host.services.size).toBe(2);
		expect(host.services.has("alpha")).toBe(true);
		expect(host.services.has("beta")).toBe(true);
		expect(host.services.get("alpha")?.mountConfig.mount).toBe("/a");
	});

	test("serviceContext is populated after init", async () => {
		const svc = createService({
			id: "x",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
		});

		const host = createHost({
			services: [svc({ mount: "/x" })],
		});

		// Before init — no context
		expect(host.services.get("x")?.serviceContext).toBeUndefined();

		await host.init();

		// After init — context exists
		const ctx = host.services.get("x")?.serviceContext;
		expect(ctx).toBeDefined();
		expect(ctx?.hostInfo.mountPath).toBe("/x");

		await host.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 8. Mixed database dependencies
// ---------------------------------------------------------------------------

describe("mixed database dependencies", () => {
	test("services with and without database coexist", async () => {
		const testDb = await createTestDatabase();
		testDb.run(CREATE_ALPHA_ITEMS);

		const withDb = createService({
			id: "alpha",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const withoutDb = createService({
			id: "nodb",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
		});

		const host = createHost({
			database: testDb.raw,
			services: [withDb({ mount: "/alpha" }), withoutDb({ mount: "/nodb" })],
		});

		await host.init();

		// DB service has a working adapter
		const ctxDb = host.services.get("alpha")?.serviceContext!;
		await ctxDb.db.items.create({ id: "1", name: "test", value: 1 });
		expect(await ctxDb.db.items.count()).toBe(1);

		// Non-DB service has no adapter (it's undefined)
		const ctxNoDb = host.services.get("nodb")?.serviceContext!;
		expect(ctxNoDb.hostInfo.mountPath).toBe("/nodb");

		await host.shutdown();
		await testDb.close();
	});
});

// ---------------------------------------------------------------------------
// 9. Logger wiring
// ---------------------------------------------------------------------------

describe("logger", () => {
	test("logger prefix includes service ID", async () => {
		const logs: string[] = [];
		const originalInfo = console.info;
		console.info = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		const svc = createService({
			id: "myservice",
			version: "1.0.0",
			dependencies: { database: false },
			endpoints: {},
			onInit: async (ctx) => {
				ctx.logger.info("hello");
			},
		});

		const host = createHost({
			services: [svc({ mount: "/x" })],
		});

		await host.init();
		console.info = originalInfo;

		expect(logs.some((l) => l.includes("[futonic:myservice]"))).toBe(true);
		expect(logs.some((l) => l.includes("hello"))).toBe(true);

		await host.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 10. Full HTTP stack: createHost → ServiceContext → middleware → router
//
// These prove that futonic's wiring actually delivers the right context
// to the right endpoint at the right path through standard Request/Response.
// ---------------------------------------------------------------------------

describe("full HTTP wiring through createHost", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	afterEach(async () => {
		await db.close();
	});

	test("endpoint receives correct ServiceContext via createHost wiring", async () => {
		db.run("CREATE TABLE echo_items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

		const echoSchema = {
			tables: {
				items: {
					fields: {
						id: {
							type: "string" as const,
							primaryKey: true,
							required: true,
						},
						name: { type: "string" as const, required: true },
					},
				},
			},
		} satisfies ServiceDBSchema;

		const svc = createService({
			id: "echo",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: echoSchema,
			endpoints: {},
		});

		const mounted = svc({
			mount: "/api/echo",
			config: { secret: "abc" },
		});

		const host = createHost({
			database: db.raw,
			baseURL: "http://testhost:9999",
			services: [mounted],
		});

		await host.init();

		const ctx = mounted.serviceContext!;
		const middleware = createServiceMiddleware(ctx);

		// Endpoint that echoes the ServiceContext it received
		const echoEndpoint = createEndpoint(
			"/context",
			{ method: "GET", use: [middleware] },
			async (handlerCtx) => {
				const svcCtx = (handlerCtx as any).context.serviceCtx as ServiceContext;
				return {
					mountPath: svcCtx.hostInfo.mountPath,
					baseURL: svcCtx.hostInfo.baseURL,
					config: svcCtx.config,
					hasDb: svcCtx.db !== undefined,
				};
			},
		);

		const router = createRouter({ echoEndpoint }, { basePath: "/api/echo" });

		const res = await router.handler(
			new Request("http://testhost:9999/api/echo/context"),
		);

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.mountPath).toBe("/api/echo");
		expect(data.baseURL).toBe("http://testhost:9999");
		expect(data.config).toEqual({ secret: "abc" });
		expect(data.hasDb).toBe(true);

		await host.shutdown();
	});

	test("endpoint can CRUD through the full host-wired adapter", async () => {
		db.run(
			"CREATE TABLE store_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);

		const svc = createService({
			id: "store",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const mounted = svc({ mount: "/api/store" });
		const host = createHost({
			database: db.raw,
			services: [mounted],
		});
		await host.init();

		const ctx = mounted.serviceContext!;
		const middleware = createServiceMiddleware(ctx);

		const createItem = createEndpoint(
			"/items",
			{ method: "POST", use: [middleware] },
			async (handlerCtx) => {
				const svcCtx = (handlerCtx as any).context.serviceCtx as ServiceContext;
				const body = (handlerCtx as any).body || {};
				return svcCtx.db.items.create({
					id: body.id,
					name: body.name,
					value: body.value ?? null,
				});
			},
		);

		const listItems = createEndpoint(
			"/items",
			{ method: "GET", use: [middleware] },
			async (handlerCtx) => {
				const svcCtx = (handlerCtx as any).context.serviceCtx as ServiceContext;
				const items = await svcCtx.db.items.findMany();
				return { items, total: items.length };
			},
		);

		const router = createRouter(
			{ createItem, listItems },
			{ basePath: "/api/store" },
		);

		// Create
		const createRes = await router.handler(
			new Request("http://localhost/api/store/items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "x1",
					name: "widget",
					value: 42,
				}),
			}),
		);
		expect(createRes.status).toBe(200);
		const created = await createRes.json();
		expect(created.id).toBe("x1");
		expect(created.name).toBe("widget");

		// List
		const listRes = await router.handler(
			new Request("http://localhost/api/store/items"),
		);
		expect(listRes.status).toBe(200);
		const listed = await listRes.json();
		expect(listed.total).toBe(1);
		expect(listed.items[0].id).toBe("x1");

		await host.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 11. Multi-service HTTP routing
//
// Two services mounted at different paths, each with their own DB tables.
// Verifies mount path scoping + context isolation through the HTTP layer.
// ---------------------------------------------------------------------------

describe("multi-service HTTP routing", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(
			"CREATE TABLE inventory_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);
		db.run(
			"CREATE TABLE analytics_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);
	});

	afterEach(async () => {
		await db.close();
	});

	test("two services on different mount paths get correct context and don't cross-contaminate", async () => {
		const inventorySvc = createService({
			id: "inventory",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const analyticsSvc = createService({
			id: "analytics",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const mountedInv = inventorySvc({ mount: "/api/inventory" });
		const mountedAna = analyticsSvc({ mount: "/api/analytics" });

		const host = createHost({
			database: db.raw,
			baseURL: "http://multi.test",
			services: [mountedInv, mountedAna],
		});

		await host.init();

		// Build routers for each service — same endpoint shape, different contexts
		function buildRouter(mounted: typeof mountedInv, basePath: string) {
			const ctx = mounted.serviceContext!;
			const mw = createServiceMiddleware(ctx);

			const create = createEndpoint(
				"/items",
				{ method: "POST", use: [mw] },
				async (handlerCtx) => {
					const svcCtx = (handlerCtx as any).context
						.serviceCtx as ServiceContext;
					const body = (handlerCtx as any).body || {};
					return svcCtx.db.items.create({
						id: body.id,
						name: body.name,
						value: body.value ?? null,
					});
				},
			);

			const list = createEndpoint(
				"/items",
				{ method: "GET", use: [mw] },
				async (handlerCtx) => {
					const svcCtx = (handlerCtx as any).context
						.serviceCtx as ServiceContext;
					return {
						items: await svcCtx.db.items.findMany(),
						mountPath: svcCtx.hostInfo.mountPath,
					};
				},
			);

			return createRouter({ create, list }, { basePath });
		}

		const invRouter = buildRouter(mountedInv, "/api/inventory");
		const anaRouter = buildRouter(mountedAna, "/api/analytics");

		// Write to inventory
		const invCreateRes = await invRouter.handler(
			new Request("http://multi.test/api/inventory/items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "inv-1",
					name: "screws",
					value: 100,
				}),
			}),
		);
		expect(invCreateRes.status).toBe(200);

		// Write to analytics
		const anaCreateRes = await anaRouter.handler(
			new Request("http://multi.test/api/analytics/items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "ana-1",
					name: "page_views",
					value: 9999,
				}),
			}),
		);
		expect(anaCreateRes.status).toBe(200);

		// List from inventory — should only see inventory data
		const invListRes = await invRouter.handler(
			new Request("http://multi.test/api/inventory/items"),
		);
		const invData = await invListRes.json();
		expect(invData.items).toHaveLength(1);
		expect(invData.items[0].name).toBe("screws");
		expect(invData.mountPath).toBe("/api/inventory");

		// List from analytics — should only see analytics data
		const anaListRes = await anaRouter.handler(
			new Request("http://multi.test/api/analytics/items"),
		);
		const anaData = await anaListRes.json();
		expect(anaData.items).toHaveLength(1);
		expect(anaData.items[0].name).toBe("page_views");
		expect(anaData.mountPath).toBe("/api/analytics");

		// Verify at SQL level — data lives in separate prefixed tables
		const rawInv = await db.kysely
			.selectFrom("inventory_items")
			.selectAll()
			.execute();
		const rawAna = await db.kysely
			.selectFrom("analytics_items")
			.selectAll()
			.execute();
		expect(rawInv).toHaveLength(1);
		expect(rawAna).toHaveLength(1);
		expect((rawInv[0] as any).name).toBe("screws");
		expect((rawAna[0] as any).name).toBe("page_views");

		await host.shutdown();
	});

	test("wrong mount path returns 404 from router", async () => {
		const svc = createService({
			id: "inventory",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const mounted = svc({ mount: "/api/inventory" });
		const host = createHost({
			database: db.raw,
			services: [mounted],
		});
		await host.init();

		const mw = createServiceMiddleware(mounted.serviceContext!);
		const list = createEndpoint(
			"/items",
			{ method: "GET", use: [mw] },
			async () => ({ items: [] }),
		);

		const router = createRouter({ list }, { basePath: "/api/inventory" });

		// Correct path works
		const goodRes = await router.handler(
			new Request("http://localhost/api/inventory/items"),
		);
		expect(goodRes.status).toBe(200);

		// Wrong path → 404
		const badRes = await router.handler(
			new Request("http://localhost/api/billing/items"),
		);
		expect(badRes.status).toBe(404);

		// Partial path → 404
		const partialRes = await router.handler(
			new Request("http://localhost/api/inventory"),
		);
		expect(partialRes.status).toBe(404);

		await host.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 12. Middleware composition
//
// Verifies that multiple middlewares compose correctly and the
// ServiceContext middleware integrates with custom middlewares.
// ---------------------------------------------------------------------------

describe("middleware composition", () => {
	test("ServiceContext middleware composes with custom middleware", async () => {
		const db = await createTestDatabase();
		db.run(
			"CREATE TABLE mw_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);

		const svc = createService({
			id: "mw",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: simpleSchema,
			endpoints: {},
		});

		const mounted = svc({ mount: "/api/mw" });
		const host = createHost({
			database: db.raw,
			services: [mounted],
		});
		await host.init();

		const svcMiddleware = createServiceMiddleware(mounted.serviceContext!);

		// Custom middleware that adds a request ID
		const requestIdMiddleware = createMiddleware(async () => {
			return { requestId: "req-12345" };
		});

		const endpoint = createEndpoint(
			"/test",
			{ method: "GET", use: [svcMiddleware, requestIdMiddleware] },
			async (handlerCtx) => {
				const ctx = (handlerCtx as any).context;
				return {
					hasServiceCtx: ctx.serviceCtx !== undefined,
					hasDb: ctx.serviceCtx?.db !== undefined,
					requestId: ctx.requestId,
				};
			},
		);

		const router = createRouter({ endpoint }, { basePath: "/api/mw" });

		const res = await router.handler(
			new Request("http://localhost/api/mw/test"),
		);
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.hasServiceCtx).toBe(true);
		expect(data.hasDb).toBe(true);
		expect(data.requestId).toBe("req-12345");

		await host.shutdown();
		await db.close();
	});

	test("middleware execution order is preserved", async () => {
		const order: string[] = [];

		const mw1 = createMiddleware(async () => {
			order.push("first");
			return {};
		});

		const mw2 = createMiddleware(async () => {
			order.push("second");
			return {};
		});

		const mw3 = createMiddleware(async () => {
			order.push("third");
			return {};
		});

		const endpoint = createEndpoint(
			"/order",
			{ method: "GET", use: [mw1, mw2, mw3] },
			async () => {
				order.push("handler");
				return { ok: true };
			},
		);

		const router = createRouter({ endpoint }, { basePath: "/test" });

		await router.handler(new Request("http://localhost/test/order"));

		expect(order).toEqual(["first", "second", "third", "handler"]);
	});
});

// ---------------------------------------------------------------------------
// 13. Endpoint error handling through the HTTP layer
// ---------------------------------------------------------------------------

describe("endpoint error handling", () => {
	test("unhandled error in endpoint returns 500", async () => {
		const boom = createEndpoint("/boom", { method: "GET" }, async () => {
			throw new Error("kaboom");
		});

		const router = createRouter({ boom }, { basePath: "/api" });

		const res = await router.handler(new Request("http://localhost/api/boom"));
		expect(res.status).toBe(500);
	});

	test("endpoint can return a custom Response object for error codes", async () => {
		const notFound = createEndpoint("/missing", { method: "GET" }, async () => {
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});

		const router = createRouter({ notFound }, { basePath: "/api" });

		const res = await router.handler(
			new Request("http://localhost/api/missing"),
		);
		expect(res.status).toBe(404);
		const data = await res.json();
		expect(data.error).toBe("not found");
	});
});

// ---------------------------------------------------------------------------
// 14. Multiple tables per service
// ---------------------------------------------------------------------------

describe("multiple tables per service", () => {
	test("service with multiple tables can CRUD each independently", async () => {
		const multiSchema = {
			tables: {
				users: {
					fields: {
						id: {
							type: "string" as const,
							primaryKey: true,
							required: true,
						},
						email: { type: "string" as const, required: true },
					},
				},
				posts: {
					fields: {
						id: {
							type: "string" as const,
							primaryKey: true,
							required: true,
						},
						title: { type: "string" as const, required: true },
						author_id: { type: "string" as const, required: true },
					},
				},
			},
		} satisfies ServiceDBSchema;

		const db = await createTestDatabase();
		db.run(
			"CREATE TABLE blog_users (id TEXT PRIMARY KEY, email TEXT NOT NULL)",
		);
		db.run(
			"CREATE TABLE blog_posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, author_id TEXT NOT NULL)",
		);

		const svc = createService({
			id: "blog",
			version: "1.0.0",
			dependencies: { database: true },
			dbSchema: multiSchema,
			endpoints: {},
		});

		const host = createHost({
			database: db.raw,
			services: [svc({ mount: "/api/blog" })],
		});
		await host.init();

		const ctx = host.services.get("blog")?.serviceContext!;

		// Create a user
		await ctx.db.users.create({ id: "u1", email: "alice@test.com" });

		// Create posts
		await ctx.db.posts.create({
			id: "p1",
			title: "First Post",
			author_id: "u1",
		});
		await ctx.db.posts.create({
			id: "p2",
			title: "Second Post",
			author_id: "u1",
		});

		// Query each table independently
		expect(await ctx.db.users.count()).toBe(1);
		expect(await ctx.db.posts.count()).toBe(2);

		const posts = await ctx.db.posts.findMany({
			where: [{ field: "author_id", value: "u1" }],
		});
		expect(posts).toHaveLength(2);

		// Tables don't leak into each other
		expect(() => (ctx.db as any).comments).toThrow(
			'does not have a table named "comments"',
		);

		await host.shutdown();
		await db.close();
	});
});
