/**
 * End-to-end integration tests.
 *
 * Proves the full loop: define service → mount in host → init with real
 * SQLite → CRUD through InternalAdapter → hit endpoints via Request/Response.
 *
 * Uses test-utils.ts for portable SQLite (bun:sqlite on Bun, better-sqlite3
 * on Node). No framework needed — better-call's router.handler works with
 * standard Web Request/Response.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createEndpoint, createMiddleware, createRouter } from "better-call";
import type { ServiceContext } from "./core/context";
import { createHost } from "./core/host";
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

	test("count returns correct count", async () => {
		const total = await adapter.invoices.count();
		expect(total).toBe(3);

		const draftCount = await adapter.invoices.count([
			{ field: "status", value: "draft" },
		]);
		expect(draftCount).toBe(2);
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
// 4. createHost lifecycle with real DB
// ---------------------------------------------------------------------------

describe("createHost (real SQLite)", () => {
	test("full lifecycle: init → services get working DB → shutdown", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);

		let capturedCtx: ServiceContext | null = null;

		const billingService = createService({
			id: "billing",
			version: "0.1.0",
			dependencies: { database: true },
			dbSchema: billingSchema,
			endpoints: {},
			onInit: async (ctx) => {
				capturedCtx = ctx;
				await ctx.db.invoices.create({
					id: "init-1",
					amount: 999,
					status: "created-in-init",
				});
			},
		});

		const host = createHost({
			database: db.raw,
			baseURL: "http://localhost:3000",
			services: [billingService({ mount: "/api/billing" })],
		});

		await host.init();

		expect(capturedCtx).not.toBeNull();
		expect(capturedCtx?.hostInfo.mountPath).toBe("/api/billing");
		expect(capturedCtx?.hostInfo.baseURL).toBe("http://localhost:3000");

		const row = await capturedCtx?.db.invoices.findOne([
			{ field: "id", value: "init-1" },
		]);
		expect(row?.amount).toBe(999);

		await host.shutdown();
		await db.close();
	});
});

// ---------------------------------------------------------------------------
// 5. Router handler end-to-end (Request → endpoint → DB → Response)
// ---------------------------------------------------------------------------

describe("router handler end-to-end", () => {
	test("GET endpoint reads from DB and returns JSON", async () => {
		const db = await createTestDatabase();
		db.run(CREATE_TABLE);
		db.run(
			"INSERT INTO billing_invoices VALUES ('inv-1', 100, 'draft', 'Alice')",
		);
		db.run("INSERT INTO billing_invoices VALUES ('inv-2', 200, 'sent', 'Bob')");

		const adapter = createInternalAdapter(db.kysely, "billing", billingSchema);

		const serviceMiddleware = createMiddleware(async () => {
			return { serviceCtx: { db: adapter } };
		});

		const listInvoices = createEndpoint(
			"/invoices",
			{ method: "GET", use: [serviceMiddleware] },
			async (ctx) => {
				const svc = (ctx as any).context.serviceCtx;
				const items = await svc.db.invoices.findMany({ limit: 10 });
				return { items, total: items.length };
			},
		);

		const router = createRouter({ listInvoices }, { basePath: "/api/billing" });

		const res = await router.handler(
			new Request("http://localhost/api/billing/invoices", { method: "GET" }),
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

		const adapter = createInternalAdapter(db.kysely, "billing", billingSchema);

		const serviceMiddleware = createMiddleware(async () => {
			return { serviceCtx: { db: adapter } };
		});

		const createInvoice = createEndpoint(
			"/invoices",
			{ method: "POST", use: [serviceMiddleware] },
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
		);

		const router = createRouter(
			{ createInvoice },
			{ basePath: "/api/billing" },
		);

		const res = await router.handler(
			new Request("http://localhost/api/billing/invoices", {
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

		// Verify it's actually persisted
		const rows = await adapter.invoices.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.customer_name).toBe("Dave");

		await db.close();
	});
});
