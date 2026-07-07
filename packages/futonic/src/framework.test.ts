/**
 * Framework-level tests for futonic's core contracts.
 *
 * These test the framework's guarantees — handler construction, context
 * wiring, adapter edge cases, error propagation — for a single self-running
 * service (futonic no longer has a multi-service host).
 *
 * A service exposes a single entry point: `createHandler(mountInfo)` builds
 * the ServiceContext, wires the endpoints, and returns a request handler.
 * The router carries no basePath — the host strips the mount prefix, so the
 * handler always sees bare, service-relative paths.
 *
 * Every test creates its own in-memory SQLite via test-utils, so there
 * are no ordering dependencies between tests.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type Middleware,
	createEndpoint,
	createMiddleware,
	createRouter,
} from "better-call";
import { type ServiceContext, createLogger } from "./core/context";
import { createService } from "./core/service";
import { createInternalAdapter } from "./db/internal-adapter";
import type { ServiceDBSchema } from "./db/schema";
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

// Adapter-level tests use the "test" service id → test_items.
const CREATE_ITEMS = `CREATE TABLE test_items (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	value INTEGER
)`;

// ---------------------------------------------------------------------------
// 1. createHandler contract
// ---------------------------------------------------------------------------

describe("createHandler contract", () => {
	test("returns a handler bound to a ServiceContext carrying the mountInfo", async () => {
		let seenMount: string | undefined;

		const svc = createService({
			id: "a",
			version: "1.0.0",
			endpoints: (use: Middleware[]) => ({
				ctx: createEndpoint("/ctx", { method: "GET", use }, async (c) => {
					const svcCtx = (c as any).context.serviceCtx as ServiceContext;
					seenMount = svcCtx.mountInfo.mountPath;
					return { mountPath: svcCtx.mountInfo.mountPath };
				}),
			}),
			// no db needed
		})({} as any);

		const handler = await svc.createHandler({ baseURL: "", mountPath: "/a" });
		// Bare, service-relative path — the host has already stripped the mount.
		const res = await handler(new Request("http://localhost/ctx"));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mountPath: "/a" });
		expect(seenMount).toBe("/a");
	});

	test("service without endpoints still produces a working handler", async () => {
		const svc = createService({
			id: "bare",
			version: "1.0.0",
			endpoints: () => ({}),
		})({} as any);

		const handler = await svc.createHandler({ baseURL: "", mountPath: "/bare" });
		// No routes → any request 404s, but the handler exists and runs.
		const res = await handler(new Request("http://localhost/anything"));
		expect(res.status).toBe(404);
	});

	test("createHandler rejects when dbSchema present but no database provided", async () => {
		const svc = createService({
			id: "needsdb",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: () => ({}),
		})({} as any);

		await expect(
			svc.createHandler({ baseURL: "", mountPath: "/x" }),
		).rejects.toThrow("no database connection");
	});

	test("each createHandler call builds an independent handler", async () => {
		const svc = createService({
			id: "multi",
			version: "1.0.0",
			endpoints: () => ({}),
		})({} as any);

		const h1 = await svc.createHandler({ baseURL: "", mountPath: "/one" });
		const h2 = await svc.createHandler({ baseURL: "", mountPath: "/two" });
		expect(h1).not.toBe(h2);
	});
});

// ---------------------------------------------------------------------------
// 3. Service context / config / logger / mountInfo
//
// The ServiceContext is no longer exposed on the runnable; it's only visible
// to endpoints via the injected middleware. So we assert on it by returning
// its fields from an endpoint.
// ---------------------------------------------------------------------------

describe("service context", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(`CREATE TABLE alpha_items (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			value INTEGER
		)`);
	});

	afterEach(async () => {
		await db.close();
	});

	test("ServiceContext exposes db, config, logger, mountInfo", async () => {
		const svc = createService({
			id: "alpha",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: (use: Middleware[]) => ({
				ctx: createEndpoint("/ctx", { method: "GET", use }, async (c) => {
					const svcCtx = (c as any).context.serviceCtx as ServiceContext;
					return {
						hasDb: svcCtx.db !== undefined,
						hasLogger: typeof svcCtx.logger?.info === "function",
						config: svcCtx.config,
						mountPath: svcCtx.mountInfo.mountPath,
						baseURL: svcCtx.mountInfo.baseURL,
					};
				}),
			}),
		})({
			database: db.raw,
			config: { apiKey: "secret-123", maxRetries: 3 },
		});

		const handler = await svc.createHandler({
			baseURL: "http://localhost:3000",
			mountPath: "/api/alpha",
		});
		const res = await handler(new Request("http://localhost/ctx"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.hasDb).toBe(true);
		expect(data.hasLogger).toBe(true);
		expect(data.config).toEqual({ apiKey: "secret-123", maxRetries: 3 });
		expect(data.mountPath).toBe("/api/alpha");
		expect(data.baseURL).toBe("http://localhost:3000");
	});

	test("service without a dbSchema still gets a context (no db access needed)", async () => {
		const svc = createService({
			id: "nodb",
			version: "1.0.0",
			endpoints: (use: Middleware[]) => ({
				ctx: createEndpoint("/ctx", { method: "GET", use }, async (c) => {
					const svcCtx = (c as any).context.serviceCtx as ServiceContext;
					return {
						mountPath: svcCtx.mountInfo.mountPath,
						config: svcCtx.config,
					};
				}),
			}),
		})({ config: { foo: "bar" } } as any);

		const handler = await svc.createHandler({ baseURL: "", mountPath: "/nodb" });
		const res = await handler(new Request("http://localhost/ctx"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.mountPath).toBe("/nodb");
		expect(data.config).toEqual({ foo: "bar" });
	});

	test("accessing a table not in the schema throws", () => {
		// Pure adapter concern — the service wires this same adapter into ctx.db.
		const adapter = createInternalAdapter(db.kysely, "alpha", simpleSchema);
		expect(() => (adapter as any).nonexistent).toThrow(
			'does not have a table named "nonexistent"',
		);
	});
});

// ---------------------------------------------------------------------------
// 4. Logger wiring
// ---------------------------------------------------------------------------

describe("logger", () => {
	test("logger prefix is [<id>]", () => {
		const logs: string[] = [];
		const originalInfo = console.info;
		console.info = (...args: unknown[]) => {
			logs.push(args.join(" "));
		};

		try {
			const logger = createLogger("myservice");
			logger.info("hello");
		} finally {
			console.info = originalInfo;
		}

		expect(logs.some((l) => l.includes("[myservice]"))).toBe(true);
		expect(logs.some((l) => l.includes("hello"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. Two independent services sharing one database (isolation)
// ---------------------------------------------------------------------------

describe("independent services isolation", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
		db.run(`CREATE TABLE alpha_items (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			value INTEGER
		)`);
		db.run(`CREATE TABLE beta_items (
			id TEXT PRIMARY KEY NOT NULL,
			name TEXT NOT NULL,
			value INTEGER
		)`);
	});

	afterEach(async () => {
		await db.close();
	});

	test("data written by one service is invisible to another", async () => {
		// Each service gets create/list endpoints; we drive them via their own
		// handlers since ctx.db is no longer exposed on the runnable.
		const itemEndpoints = (use: Middleware[]) => ({
			create: createEndpoint("/items", { method: "POST", use }, async (c) => {
				const svcCtx = (c as any).context.serviceCtx as ServiceContext;
				const body = (c as any).body || {};
				return (svcCtx.db as any).items.create({
					id: body.id,
					name: body.name,
					value: body.value ?? null,
				});
			}),
			list: createEndpoint("/items", { method: "GET", use }, async (c) => {
				const svcCtx = (c as any).context.serviceCtx as ServiceContext;
				const items = await (svcCtx.db as any).items.findMany();
				return { items, total: items.length };
			}),
		});

		const alpha = createService({
			id: "alpha",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: itemEndpoints,
		})({ database: db.raw });

		const beta = createService({
			id: "beta",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: itemEndpoints,
		})({ database: db.raw });

		const alphaHandler = await alpha.createHandler({
			baseURL: "",
			mountPath: "/api/alpha",
		});
		const betaHandler = await beta.createHandler({
			baseURL: "",
			mountPath: "/api/beta",
		});

		const post = (h: typeof alphaHandler, body: unknown) =>
			h(
				new Request("http://localhost/items", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		const listCount = async (h: typeof alphaHandler) => {
			const res = await h(new Request("http://localhost/items"));
			return (await res.json()).total as number;
		};

		// Write to alpha; beta sees nothing.
		await post(alphaHandler, { id: "a1", name: "alpha-only", value: 1 });
		expect(await listCount(betaHandler)).toBe(0);
		expect(await listCount(alphaHandler)).toBe(1);

		// Write to beta; each still sees only its own.
		await post(betaHandler, { id: "b1", name: "beta-only", value: 2 });
		expect(await listCount(alphaHandler)).toBe(1);
		expect(await listCount(betaHandler)).toBe(1);
		// db.close() in afterEach is the single teardown (no shutdown calls).
	});
});

// ---------------------------------------------------------------------------
// 6. Service factory behavior
// ---------------------------------------------------------------------------

describe("service factory", () => {
	test("same factory produces independent instances", () => {
		const factory = createService({
			id: "svc",
			version: "1.0.0",
			endpoints: () => ({}),
		});

		const a = factory({ config: { key: "a" } } as any);
		const b = factory({ config: { key: "b" } } as any);

		expect(a).not.toBe(b);
		expect(a.id).toBe("svc");
		expect(b.id).toBe("svc");
		expect(a.version).toBe("1.0.0");
	});
});

// ---------------------------------------------------------------------------
// 7. InternalAdapter edge cases
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

	// -- filter (FilterNode boolean tree) --

	describe("filter (FilterNode tree)", () => {
		beforeEach(async () => {
			const a = adapter();
			await a.items.create({ id: "1", name: "apple", value: 10 });
			await a.items.create({ id: "2", name: "banana", value: 20 });
			await a.items.create({ id: "3", name: "cherry", value: 30 });
			await a.items.create({ id: "4", name: "grape", value: 40 });
		});

		test("simple cond", async () => {
			const found = await adapter().items.findMany({
				filter: { type: "cond", field: "value", op: "gt", value: 25 },
			});
			expect(found.map((r) => r.id).sort()).toEqual(["3", "4"]);
		});

		test("and", async () => {
			const found = await adapter().items.findMany({
				filter: {
					type: "and",
					nodes: [
						{ type: "cond", field: "value", op: "gte", value: 20 },
						{ type: "cond", field: "value", op: "lte", value: 30 },
					],
				},
			});
			expect(found.map((r) => r.value).sort()).toEqual([20, 30]);
		});

		test("or", async () => {
			const found = await adapter().items.findMany({
				filter: {
					type: "or",
					nodes: [
						{ type: "cond", field: "value", op: "eq", value: 10 },
						{ type: "cond", field: "value", op: "eq", value: 40 },
					],
				},
			});
			expect(found.map((r) => r.value).sort()).toEqual([10, 40]);
		});

		test("not", async () => {
			const found = await adapter().items.findMany({
				filter: {
					type: "not",
					node: { type: "cond", field: "value", op: "eq", value: 20 },
				},
			});
			expect(found).toHaveLength(3);
			expect(found.some((r) => r.value === 20)).toBe(false);
		});

		test("contains (LIKE)", async () => {
			const found = await adapter().items.findMany({
				filter: { type: "cond", field: "name", op: "contains", value: "an" },
			});
			// only banana contains "an"
			expect(found.map((r) => r.name).sort()).toEqual(["banana"]);
		});

		test("startsWith / endsWith", async () => {
			const starts = await adapter().items.findMany({
				filter: {
					type: "cond",
					field: "name",
					op: "startsWith",
					value: "gr",
				},
			});
			expect(starts.map((r) => r.name)).toEqual(["grape"]);

			const ends = await adapter().items.findMany({
				filter: { type: "cond", field: "name", op: "endsWith", value: "y" },
			});
			expect(ends.map((r) => r.name)).toEqual(["cherry"]);
		});

		test("count honors filter", async () => {
			const c = await adapter().items.count({
				filter: { type: "cond", field: "value", op: "gte", value: 30 },
			});
			expect(c).toBe(2);
		});
	});

	// -- select (column projection) --

	describe("select (column projection)", () => {
		beforeEach(async () => {
			await adapter().items.create({ id: "1", name: "x", value: 99 });
		});

		test("select limits returned columns", async () => {
			const found = await adapter().items.findMany({ select: ["id", "name"] });
			expect(found).toHaveLength(1);
			expect(Object.keys(found[0] as object).sort()).toEqual(["id", "name"]);
			expect((found[0] as any).value).toBeUndefined();
		});

		test("omitting select returns all columns", async () => {
			const found = await adapter().items.findMany();
			expect(Object.keys(found[0] as object).sort()).toEqual([
				"id",
				"name",
				"value",
			]);
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

		await a.items.update([{ field: "id", value: "2" }], { name: "changed" });

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
// 8. Concurrent database operations
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
				a.items.create({ id: `item-${i}`, name: `name-${i}`, value: i }),
			),
		);

		expect(await a.items.count()).toBe(20);
		expect(await a.items.findMany()).toHaveLength(20);
	});

	test("parallel reads return consistent data", async () => {
		const a = createInternalAdapter(db.kysely, "test", simpleSchema);

		for (let i = 0; i < 10; i++) {
			await a.items.create({ id: `s-${i}`, name: `n-${i}`, value: i });
		}

		const results = await Promise.all(
			Array.from({ length: 10 }, () => a.items.findMany()),
		);

		for (const result of results) {
			expect(result).toHaveLength(10);
		}
	});
});

// ---------------------------------------------------------------------------
// 9. Full HTTP wiring through a single service
//
// Drives the handler returned by createHandler() directly. Proves futonic
// wires the right ServiceContext into the endpoint via the injected
// middleware passed to the endpoints factory. The router has no basePath, so
// requests use bare, service-relative paths (the host strips the mount).
// ---------------------------------------------------------------------------

describe("full HTTP wiring", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	afterEach(async () => {
		await db.close();
	});

	test("endpoint receives correct ServiceContext via the handler", async () => {
		db.run("CREATE TABLE echo_items (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

		const echoSchema = {
			tables: {
				items: {
					fields: {
						id: { type: "string" as const, primaryKey: true, required: true },
						name: { type: "string" as const, required: true },
					},
				},
			},
		} satisfies ServiceDBSchema;

		const svc = createService({
			id: "echo",
			version: "1.0.0",
			dbSchema: echoSchema,
			endpoints: (use: Middleware[]) => ({
				getContext: createEndpoint(
					"/context",
					{ method: "GET", use },
					async (handlerCtx) => {
						const svcCtx = (handlerCtx as any).context
							.serviceCtx as ServiceContext;
						return {
							mountPath: svcCtx.mountInfo.mountPath,
							baseURL: svcCtx.mountInfo.baseURL,
							config: svcCtx.config,
							hasDb: svcCtx.db !== undefined,
						};
					},
				),
			}),
		})({
			database: db.raw,
			config: { secret: "abc" },
		});

		const handler = await svc.createHandler({
			baseURL: "http://testhost:9999",
			mountPath: "/api/echo",
		});

		const res = await handler(new Request("http://testhost:9999/context"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.mountPath).toBe("/api/echo");
		expect(data.baseURL).toBe("http://testhost:9999");
		expect(data.config).toEqual({ secret: "abc" });
		expect(data.hasDb).toBe(true);
	});

	test("endpoint can CRUD through the full service-wired adapter", async () => {
		db.run(
			"CREATE TABLE store_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);

		const svc = createService({
			id: "store",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: (use: Middleware[]) => ({
				createItem: createEndpoint(
					"/items",
					{ method: "POST", use },
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
				),
				listItems: createEndpoint(
					"/items",
					{ method: "GET", use },
					async (handlerCtx) => {
						const svcCtx = (handlerCtx as any).context
							.serviceCtx as ServiceContext;
						const items = await svcCtx.db.items.findMany();
						return { items, total: items.length };
					},
				),
			}),
		})({
			database: db.raw,
		});

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/store",
		});

		// Create
		const createRes = await handler(
			new Request("http://localhost/items", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "x1", name: "widget", value: 42 }),
			}),
		);
		expect(createRes.status).toBe(200);
		const created = await createRes.json();
		expect(created.id).toBe("x1");
		expect(created.name).toBe("widget");

		// List
		const listRes = await handler(new Request("http://localhost/items"));
		expect(listRes.status).toBe(200);
		const listed = await listRes.json();
		expect(listed.total).toBe(1);
		expect(listed.items[0].id).toBe("x1");
	});

	test("unknown path returns 404", async () => {
		const svc = createService({
			id: "inventory",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: (use: Middleware[]) => ({
				list: createEndpoint("/items", { method: "GET", use }, async () => ({
					items: [],
				})),
			}),
		})({
			database: db.raw,
		});

		db.run(
			"CREATE TABLE inventory_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/inventory",
		});

		// Known bare path works.
		const goodRes = await handler(new Request("http://localhost/items"));
		expect(goodRes.status).toBe(200);

		// Unknown path → 404. (Prefix stripping is the host's job now; the
		// handler only ever sees service-relative paths.)
		const badRes = await handler(new Request("http://localhost/nope"));
		expect(badRes.status).toBe(404);

		// Root → 404 (no endpoint registered there).
		const rootRes = await handler(new Request("http://localhost/"));
		expect(rootRes.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// 10. Middleware composition
// ---------------------------------------------------------------------------

describe("middleware composition", () => {
	let db: TestDatabase;

	beforeEach(async () => {
		db = await createTestDatabase();
	});

	afterEach(async () => {
		await db.close();
	});

	test("ServiceContext middleware composes with custom middleware", async () => {
		db.run(
			"CREATE TABLE mw_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, value INTEGER)",
		);

		const requestIdMiddleware = createMiddleware(async () => {
			return { requestId: "req-12345" };
		});

		const svc = createService({
			id: "mw",
			version: "1.0.0",
			dbSchema: simpleSchema,
			endpoints: (use: Middleware[]) => ({
				test: createEndpoint(
					"/test",
					{ method: "GET", use: [...use, requestIdMiddleware] },
					async (handlerCtx) => {
						const ctx = (handlerCtx as any).context;
						return {
							hasServiceCtx: ctx.serviceCtx !== undefined,
							hasDb: ctx.serviceCtx?.db !== undefined,
							requestId: ctx.requestId,
						};
					},
				),
			}),
		})({
			database: db.raw,
		});

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/mw",
		});

		const res = await handler(new Request("http://localhost/test"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.hasServiceCtx).toBe(true);
		expect(data.hasDb).toBe(true);
		expect(data.requestId).toBe("req-12345");
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
// 11. Endpoint error handling through the HTTP layer
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
// 12. Multiple tables per service
// ---------------------------------------------------------------------------

describe("multiple tables per service", () => {
	test("service with multiple tables can CRUD each independently", async () => {
		const multiSchema = {
			tables: {
				users: {
					fields: {
						id: { type: "string" as const, primaryKey: true, required: true },
						email: { type: "string" as const, required: true },
					},
				},
				posts: {
					fields: {
						id: { type: "string" as const, primaryKey: true, required: true },
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

		// The service wires exactly this adapter into ctx.db; since ctx.db is no
		// longer exposed on the runnable, exercise the same adapter directly.
		const adapter = createInternalAdapter(db.kysely, "blog", multiSchema);

		await adapter.users.create({ id: "u1", email: "alice@test.com" });
		await adapter.posts.create({
			id: "p1",
			title: "First Post",
			author_id: "u1",
		});
		await adapter.posts.create({
			id: "p2",
			title: "Second Post",
			author_id: "u1",
		});

		expect(await adapter.users.count()).toBe(1);
		expect(await adapter.posts.count()).toBe(2);

		const posts = await adapter.posts.findMany({
			where: [{ field: "author_id", value: "u1" }],
		});
		expect(posts).toHaveLength(2);

		// Tables don't leak into each other.
		expect(() => (adapter as any).comments).toThrow(
			'does not have a table named "comments"',
		);

		await db.close();
	});
});
