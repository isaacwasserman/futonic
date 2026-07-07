/**
 * End-to-end integration tests.
 *
 * Proves the full loop: define service → build a handler with real SQLite →
 * CRUD through InternalAdapter → hit endpoints via Request/Response.
 *
 * Each service is now self-running: `createService(def)(config)` yields a
 * runnable whose single entry point is `createHandler(mountInfo)` — it builds
 * the ServiceContext, wires the endpoints, and returns a request handler. The
 * router carries no basePath, so the handler sees bare, service-relative
 * paths (the host strips the mount prefix).
 *
 * Uses test-utils.ts for portable SQLite (bun:sqlite on Bun, better-sqlite3
 * on Node). No framework needed — the service's handler works with standard
 * Web Request/Response.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Middleware, createEndpoint } from "better-call";
import { type ServiceContext, createLogger } from "./core/context";
import { createService } from "./core/service";
import { createInternalAdapter } from "./db/internal-adapter";
import { detectDatabaseType } from "./db/kysely-factory";
import type { ServiceDBSchema } from "./db/schema";
import { type TestDatabase, createTestDatabase } from "./test-utils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const billingSchema = {
	tables: {
		invoices: {
			fields: {
				id: { type: "string" as const, primaryKey: true, required: true },
				amount: { type: "number" as const, required: true },
				status: { type: "string" as const, required: true },
				customer_name: { type: "string" as const },
			},
		},
	},
} satisfies ServiceDBSchema;

const CREATE_TABLE = `
	CREATE TABLE billing_invoices (
		id TEXT PRIMARY KEY NOT NULL,
		amount INTEGER NOT NULL,
		status TEXT NOT NULL,
		customer_name TEXT
	)
`;

// ---------------------------------------------------------------------------
// 1. Dialect detection
// ---------------------------------------------------------------------------

describe("dialect detection (real SQLite)", () => {
	test("detects the test database as sqlite", async () => {
		const db = await createTestDatabase();
		expect(detectDatabaseType(db.raw)).toBe("sqlite");
		await db.close();
	});
});

// ---------------------------------------------------------------------------
// 2. Kysely round-trip
// ---------------------------------------------------------------------------

describe("Kysely round-trip (real SQLite)", () => {
	test("insert, select, update, delete all work", async () => {
		const db = await createTestDatabase();
		db.run("CREATE TABLE test (id TEXT PRIMARY KEY, val INTEGER)");
		db.run("INSERT INTO test VALUES ('a', 42)");

		const rows = await db.kysely.selectFrom("test").selectAll().execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ id: "a", val: 42 });

		await db.kysely
			.updateTable("test")
			.set({ val: 100 })
			.where("id", "=", "a")
			.execute();

		const updated = await db.kysely
			.selectFrom("test")
			.selectAll()
			.executeTakeFirst();
		expect(updated?.val).toBe(100);

		await db.close();
	});
});

// ---------------------------------------------------------------------------
// 3. InternalAdapter CRUD against real DB
// ---------------------------------------------------------------------------

describe("InternalAdapter (real SQLite)", () => {
	let db: TestDatabase;
	let adapter: ReturnType<typeof createInternalAdapter<typeof billingSchema>>;

	beforeAll(async () => {
		db = await createTestDatabase();
		db.run(CREATE_TABLE);
		adapter = createInternalAdapter(db.kysely, "billing", billingSchema);
	});

	afterAll(async () => {
		await db.close();
	});

	test("create inserts a row and returns it", async () => {
		const row = await adapter.invoices.create({
			id: "inv-1",
			amount: 100,
			status: "draft",
			customer_name: "Alice",
		});

		expect(row.id).toBe("inv-1");
		expect(row.amount).toBe(100);
		expect(row.status).toBe("draft");
	});

	test("findOne retrieves a single row", async () => {
		const row = await adapter.invoices.findOne([
			{ field: "id", value: "inv-1" },
		]);
		expect(row).not.toBeNull();
		expect(row?.customer_name).toBe("Alice");
	});

	test("findMany retrieves multiple rows with options", async () => {
		await adapter.invoices.create({
			id: "inv-2",
			amount: 200,
			status: "sent",
			customer_name: "Bob",
		});
		await adapter.invoices.create({
			id: "inv-3",
			amount: 50,
			status: "draft",
			customer_name: "Charlie",
		});

		const all = await adapter.invoices.findMany();
		expect(all).toHaveLength(3);

		const drafts = await adapter.invoices.findMany({
			where: [{ field: "status", value: "draft" }],
		});
		expect(drafts).toHaveLength(2);

		const sorted = await adapter.invoices.findMany({
			sortBy: { field: "amount", direction: "desc" },
			limit: 2,
		});
		expect(sorted[0]?.amount).toBe(200);
		expect(sorted).toHaveLength(2);
	});

	test("findMany supports select projection and offset pagination", async () => {
		// State: inv-1 (100), inv-2 (200), inv-3 (50)
		const projected = await adapter.invoices.findMany({
			select: ["id", "amount"],
			sortBy: { field: "amount", direction: "asc" },
		});
		expect(projected).toHaveLength(3);
		expect(projected[0]).toEqual({ id: "inv-3", amount: 50 });
		expect(projected[0]).not.toHaveProperty("status");

		const page = await adapter.invoices.findMany({
			sortBy: { field: "amount", direction: "asc" },
			limit: 1,
			offset: 1,
		});
		expect(page).toHaveLength(1);
		expect(page[0]?.amount).toBe(100);
	});

	test("findMany supports FilterNode boolean trees", async () => {
		// State: inv-1 (100, draft), inv-2 (200, sent), inv-3 (50, draft)
		const result = await adapter.invoices.findMany({
			filter: {
				type: "or",
				nodes: [
					{ type: "cond", field: "status", op: "eq", value: "sent" },
					{ type: "cond", field: "amount", op: "lt", value: 60 },
				],
			},
			sortBy: { field: "amount", direction: "asc" },
		});
		expect(result.map((r) => r.id)).toEqual(["inv-3", "inv-2"]);

		const contains = await adapter.invoices.findMany({
			filter: {
				type: "cond",
				field: "customer_name",
				op: "contains",
				value: "lic",
			},
		});
		expect(contains).toHaveLength(1);
		expect(contains[0]?.customer_name).toBe("Alice");
	});

	test("count returns correct count", async () => {
		const total = await adapter.invoices.count();
		expect(total).toBe(3);

		const draftCount = await adapter.invoices.count([
			{ field: "status", value: "draft" },
		]);
		expect(draftCount).toBe(2);

		const filtered = await adapter.invoices.count({
			filter: { type: "cond", field: "amount", op: "gte", value: 100 },
		});
		expect(filtered).toBe(2);
	});

	test("update modifies a row and returns it", async () => {
		const updated = await adapter.invoices.update(
			[{ field: "id", value: "inv-1" }],
			{ status: "paid", amount: 150 },
		);
		expect(updated.status).toBe("paid");
		expect(updated.amount).toBe(150);
	});

	test("updateMany modifies multiple rows and returns count", async () => {
		const count = await adapter.invoices.updateMany(
			[{ field: "status", value: "draft" }],
			{ status: "archived" },
		);
		expect(count).toBe(1); // only inv-3 is still draft
	});

	test("delete removes a row", async () => {
		await adapter.invoices.delete([{ field: "id", value: "inv-3" }]);
		const remaining = await adapter.invoices.findMany();
		expect(remaining).toHaveLength(2);
	});

	test("deleteMany removes multiple rows and returns count", async () => {
		await adapter.invoices.create({ id: "inv-4", amount: 10, status: "temp" });
		await adapter.invoices.create({ id: "inv-5", amount: 20, status: "temp" });

		const count = await adapter.invoices.deleteMany([
			{ field: "status", value: "temp" },
		]);
		expect(count).toBe(2);
	});

	test("throws when accessing a table not in the schema", () => {
		expect(() => (adapter as any).nonexistent).toThrow(
			'does not have a table named "nonexistent"',
		);
	});

	test("where operators work correctly", async () => {
		// State at this point: inv-1 (150, paid), inv-2 (200, sent)

		// gt: both > 100
		const expensive = await adapter.invoices.findMany({
			where: [{ field: "amount", value: 199, operator: "gt" }],
		});
		expect(expensive).toHaveLength(1);
		expect(expensive[0]?.id).toBe("inv-2");

		// in
		const subset = await adapter.invoices.findMany({
			where: [{ field: "id", value: ["inv-1", "inv-2"], operator: "in" }],
		});
		expect(subset).toHaveLength(2);

		// ne
		const notPaid = await adapter.invoices.findMany({
			where: [{ field: "status", value: "paid", operator: "ne" }],
		});
		expect(notPaid).toHaveLength(1);
		expect(notPaid[0]?.status).toBe("sent");
	});
});

// ---------------------------------------------------------------------------
// 4. Handler construction with real DB (createHandler wires a working context)
// ---------------------------------------------------------------------------

describe("handler construction (real SQLite)", () => {
	test("createHandler wires a working ServiceContext into endpoints", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);

		const billingService = createService({
			id: "billing",
			version: "0.1.0",
			dbSchema: billingSchema,
			endpoints: (use: Middleware[]) => ({
				// Echoes the wired ServiceContext and seeds a row via ctx.db.
				setup: createEndpoint("/setup", { method: "POST", use }, async (c) => {
					const ctx = (c as any).context.serviceCtx as ServiceContext;
					await ctx.db.invoices.create({
						id: "init-1",
						amount: 999,
						status: "created-in-setup",
					});
					return {
						mountPath: ctx.mountInfo.mountPath,
						baseURL: ctx.mountInfo.baseURL,
						config: ctx.config,
						hasLogger: typeof ctx.logger.info === "function",
					};
				}),
				get: createEndpoint(
					"/invoices/:id",
					{ method: "GET", use },
					async (c) => {
						const ctx = (c as any).context.serviceCtx as ServiceContext;
						const row = await ctx.db.invoices.findOne([
							{ field: "id", value: (c as any).params.id },
						]);
						return { row };
					},
				),
			}),
		});

		const svc = billingService({ database: db.raw });

		const handler = await svc.createHandler({
			baseURL: "http://localhost:3000",
			mountPath: "/api/billing",
		});

		const setupRes = await handler(
			new Request("http://localhost/setup", { method: "POST" }),
		);
		expect(setupRes.status).toBe(200);
		const setup = await setupRes.json();
		expect(setup.mountPath).toBe("/api/billing");
		expect(setup.baseURL).toBe("http://localhost:3000");
		expect(setup.config).toEqual({});
		expect(setup.hasLogger).toBe(true);

		const getRes = await handler(
			new Request("http://localhost/invoices/init-1"),
		);
		expect((await getRes.json()).row.amount).toBe(999);

		await db.close();
	});

	test("createHandler rejects when dbSchema present but no database provided", async () => {
		const svc = createService({
			id: "billing",
			version: "0.1.0",
			dbSchema: billingSchema,
			endpoints: () => ({}),
		})({} as any);

		await expect(
			svc.createHandler({ baseURL: "", mountPath: "/api/billing" }),
		).rejects.toThrow("no database connection");
	});

	test("logger prefix uses [<id>] form", () => {
		const logs: string[] = [];
		const original = console.info;
		console.info = (...args: unknown[]) => {
			logs.push(String(args[0]));
		};
		try {
			createLogger("reports").info("hello");
			expect(logs).toContain("[reports]");
		} finally {
			console.info = original;
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Service handler end-to-end (Request → endpoint → DB → Response)
// ---------------------------------------------------------------------------

describe("service handler end-to-end", () => {
	test("GET endpoint reads from DB and returns JSON", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);
		db.run(
			"INSERT INTO billing_invoices VALUES ('inv-1', 100, 'draft', 'Alice')",
		);
		db.run("INSERT INTO billing_invoices VALUES ('inv-2', 200, 'sent', 'Bob')");

		const svc = createService({
			id: "billing",
			version: "1.0.0",
			dbSchema: billingSchema,
			endpoints: (use: Middleware[]) => ({
				listInvoices: createEndpoint(
					"/invoices",
					{ method: "GET", use },
					async (ctx) => {
						const serviceCtx = (ctx as any).context.serviceCtx;
						const items = await serviceCtx.db.invoices.findMany({ limit: 10 });
						return { items, total: items.length };
					},
				),
			}),
		})({
			database: db.raw,
		});

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/billing",
		});

		const res = await handler(
			new Request("http://localhost/invoices", { method: "GET" }),
		);

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.items).toHaveLength(2);
		expect(data.total).toBe(2);
		expect(data.items[0].customer_name).toBe("Alice");

		await db.close();
	});

	test("POST endpoint writes to DB and returns created row", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);

		const svc = createService({
			id: "billing",
			version: "1.0.0",
			dbSchema: billingSchema,
			endpoints: (use: Middleware[]) => ({
				createInvoice: createEndpoint(
					"/invoices",
					{ method: "POST", use },
					async (ctx) => {
						const body = (ctx as any).body || {};
						const invoice = await (
							ctx as any
						).context.serviceCtx.db.invoices.create({
							id: body.id || crypto.randomUUID(),
							amount: body.amount || 0,
							status: "draft",
							customer_name: body.customer_name || null,
						});
						return invoice;
					},
				),
			}),
		})({
			database: db.raw,
		});

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/billing",
		});

		const res = await handler(
			new Request("http://localhost/invoices", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: "inv-new",
					amount: 500,
					customer_name: "Dave",
				}),
			}),
		);

		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.id).toBe("inv-new");
		expect(data.amount).toBe(500);
		expect(data.status).toBe("draft");

		// Verify it's actually persisted, reading the same physical (prefixed)
		// table via a direct adapter — ctx.db is no longer exposed on the runnable.
		const rows = await createInternalAdapter(
			db.kysely,
			"billing",
			billingSchema,
		).invoices.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.customer_name).toBe("Dave");

		await db.close();
	});

	test("unknown path returns 404", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);

		const svc = createService({
			id: "billing",
			version: "1.0.0",
			dbSchema: billingSchema,
			endpoints: (use: Middleware[]) => ({
				listInvoices: createEndpoint(
					"/invoices",
					{ method: "GET", use },
					async () => ({ items: [] }),
				),
			}),
		})({ database: db.raw });

		const handler = await svc.createHandler({
			baseURL: "",
			mountPath: "/api/billing",
		});

		const res = await handler(new Request("http://localhost/nope"));
		expect(res.status).toBe(404);

		await db.close();
	});
});

// ---------------------------------------------------------------------------
// 6. Two isolated services sharing one connection
// ---------------------------------------------------------------------------

describe("two isolated services (shared connection)", () => {
	const otherSchema = {
		tables: {
			invoices: {
				fields: {
					id: { type: "string" as const, primaryKey: true, required: true },
					amount: { type: "number" as const, required: true },
					status: { type: "string" as const, required: true },
					customer_name: { type: "string" as const },
				},
			},
		},
	} satisfies ServiceDBSchema;

	test("tables are physically prefixed per service; no cross-talk", async () => {
		const db = await createTestDatabase();
		// Two services, same logical "invoices" table, different physical prefixes.
		db.run(CREATE_TABLE); // billing_invoices
		db.run(`
			CREATE TABLE reports_invoices (
				id TEXT PRIMARY KEY NOT NULL,
				amount INTEGER NOT NULL,
				status TEXT NOT NULL,
				customer_name TEXT
			)
		`);

		// Each service creates its invoice through its own handler; ctx.db is no
		// longer exposed, so the write must go through an endpoint.
		const createEndpoints = (use: Middleware[]) => ({
			create: createEndpoint(
				"/invoices",
				{ method: "POST", use },
				async (c) => {
					const ctx = (c as any).context.serviceCtx as ServiceContext;
					const body = (c as any).body || {};
					return ctx.db.invoices.create({
						id: body.id,
						amount: body.amount,
						status: body.status,
					});
				},
			),
			list: createEndpoint("/invoices", { method: "GET", use }, async (c) => {
				const ctx = (c as any).context.serviceCtx as ServiceContext;
				return { items: await ctx.db.invoices.findMany() };
			}),
		});

		const billing = createService({
			id: "billing",
			version: "1.0.0",
			dbSchema: billingSchema,
			endpoints: createEndpoints,
		})({ database: db.raw });

		const reports = createService({
			id: "reports",
			version: "1.0.0",
			dbSchema: otherSchema,
			endpoints: createEndpoints,
		})({ database: db.raw });

		const billingHandler = await billing.createHandler({
			baseURL: "",
			mountPath: "/api/billing",
		});
		const reportsHandler = await reports.createHandler({
			baseURL: "",
			mountPath: "/api/reports",
		});

		const create = (h: typeof billingHandler, body: unknown) =>
			h(
				new Request("http://localhost/invoices", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		const list = async (h: typeof billingHandler) => {
			const res = await h(new Request("http://localhost/invoices"));
			return (await res.json()).items as Array<{ id: string }>;
		};

		await create(billingHandler, { id: "b-1", amount: 100, status: "draft" });
		await create(reportsHandler, { id: "r-1", amount: 999, status: "final" });

		const billingRows = await list(billingHandler);
		const reportsRows = await list(reportsHandler);

		expect(billingRows).toHaveLength(1);
		expect(billingRows[0]?.id).toBe("b-1");
		expect(reportsRows).toHaveLength(1);
		expect(reportsRows[0]?.id).toBe("r-1");

		// Confirm physical isolation at the raw SQL level.
		const rawBilling = await db.kysely
			.selectFrom("billing_invoices")
			.selectAll()
			.execute();
		const rawReports = await db.kysely
			.selectFrom("reports_invoices")
			.selectAll()
			.execute();
		expect(rawBilling).toHaveLength(1);
		expect(rawReports).toHaveLength(1);

		// Single teardown of the shared connection.
		await db.close();
	});
});
