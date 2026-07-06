/**
 * End-to-end tests for the host-hono + service-billing stack.
 *
 * Each test gets its own fresh in-memory SQLite via createApp(), so tests
 * are fully isolated — no shared mutable state, no ordering dependencies.
 *
 * Tests call app.fetch() directly — the full Hono → better-call →
 * futonic → billing service → SQLite stack is exercised, just without TCP.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createApp, type App } from "./app";
import { createService } from "futonic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(path: string, init?: RequestInit) {
	return new Request(`http://localhost${path}`, init);
}

function post(path: string, body: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are untyped JSON in e2e tests
function readJson(res: Response): Promise<any> {
	return res.json();
}

function patch(path: string, body: unknown) {
	return req(path, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function del(path: string) {
	return req(path, { method: "DELETE" });
}

/** The exact set of keys a created invoice should have. */
const INVOICE_KEYS = [
	"id",
	"customer_id",
	"amount",
	"currency",
	"status",
	"due_date",
	"created_at",
].sort();

function assertInvoiceShape(obj: Record<string, unknown>, extra?: string[]) {
	const expected = [...INVOICE_KEYS, ...(extra ?? [])].sort();
	expect(Object.keys(obj).sort()).toEqual(expected);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("health check", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("GET / returns status and mounted services", async () => {
		const res = await instance.app.fetch(req("/"));
		expect(res.status).toBe(200);

		const data = await readJson(res);
		expect(data).toEqual({
			name: "host-hono",
			status: "ok",
			services: ["billing"],
		});
	});
});

// ---------------------------------------------------------------------------
// Create invoice
// ---------------------------------------------------------------------------

describe("POST /api/billing/invoices", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("creates an invoice with defaults", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "cust-1",
				amount: 100,
			}),
		);
		expect(res.status).toBe(200);

		const invoice = await readJson(res);
		assertInvoiceShape(invoice);
		expect(invoice.customer_id).toBe("cust-1");
		expect(invoice.amount).toBe(100);
		expect(invoice.currency).toBe("USD");
		expect(invoice.status).toBe("draft");
		expect(invoice.due_date).toBeNull();
		expect(typeof invoice.id).toBe("string");
		expect(invoice.id.length).toBeGreaterThan(0);
		expect(typeof invoice.created_at).toBe("string");
	});

	test("accepts all explicit fields", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "cust-2",
				amount: 500,
				currency: "EUR",
				status: "sent",
				due_date: "2026-12-31",
			}),
		);
		expect(res.status).toBe(200);

		const invoice = await readJson(res);
		assertInvoiceShape(invoice);
		expect(invoice.currency).toBe("EUR");
		expect(invoice.status).toBe("sent");
		expect(invoice.due_date).toBe("2026-12-31");
	});

	test("rejects missing customer_id", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", { amount: 100 }),
		);
		expect(res.status).toBe(400);
		const body = await readJson(res);
		expect(body.code).toBe("VALIDATION_ERROR");
	});

	test("rejects missing amount", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", { customer_id: "c1" }),
		);
		expect(res.status).toBe(400);
	});

	test("rejects non-numeric amount", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: "not-a-number",
			}),
		);
		expect(res.status).toBe(400);
		const body = await readJson(res);
		expect(body.code).toBe("VALIDATION_ERROR");
	});

	test("rejects invalid status enum", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 100,
				status: "bogus",
			}),
		);
		expect(res.status).toBe(400);
		const body = await readJson(res);
		expect(body.code).toBe("VALIDATION_ERROR");
	});

	test("rejects empty body", async () => {
		const res = await instance.app.fetch(
			req("/api/billing/invoices", { method: "POST" }),
		);
		expect(res.status).toBe(400);
	});

	test("each invoice gets a unique ID", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 5; i++) {
			const res = await instance.app.fetch(
				post("/api/billing/invoices", {
					customer_id: "c1",
					amount: i,
				}),
			);
			const { id } = await readJson(res);
			ids.add(id);
		}
		expect(ids.size).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// List invoices
// ---------------------------------------------------------------------------

describe("GET /api/billing/invoices", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("returns empty list when no invoices exist", async () => {
		const res = await instance.app.fetch(req("/api/billing/invoices"));
		expect(res.status).toBe(200);

		const data = await readJson(res);
		expect(data).toEqual({ invoices: [], total: 0 });
	});

	test("returns all invoices sorted by created_at desc", async () => {
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "first",
				amount: 1,
			}),
		);
		// Small delay to ensure different timestamps
		await new Promise((r) => setTimeout(r, 5));
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "second",
				amount: 2,
			}),
		);

		const res = await instance.app.fetch(req("/api/billing/invoices"));
		const data = await readJson(res);

		expect(data.total).toBe(2);
		expect(data.invoices).toHaveLength(2);
		// Most recent first
		expect(data.invoices[0].customer_id).toBe("second");
		expect(data.invoices[1].customer_id).toBe("first");
	});

	test("filters by status query param", async () => {
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "a",
				amount: 1,
				status: "draft",
			}),
		);
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "b",
				amount: 2,
				status: "paid",
			}),
		);
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c",
				amount: 3,
				status: "draft",
			}),
		);

		const draftRes = await instance.app.fetch(
			req("/api/billing/invoices?status=draft"),
		);
		const drafts = await readJson(draftRes);
		expect(drafts.total).toBe(2);
		expect(
			drafts.invoices.every(
				(i: Record<string, unknown>) => i.status === "draft",
			),
		).toBe(true);

		const paidRes = await instance.app.fetch(
			req("/api/billing/invoices?status=paid"),
		);
		const paid = await readJson(paidRes);
		expect(paid.total).toBe(1);
		expect(paid.invoices[0].customer_id).toBe("b");
	});

	test("filter with nonexistent status returns empty", async () => {
		await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "a",
				amount: 1,
			}),
		);

		const res = await instance.app.fetch(
			req("/api/billing/invoices?status=void"),
		);
		const data = await readJson(res);
		expect(data).toEqual({ invoices: [], total: 0 });
	});
});

// ---------------------------------------------------------------------------
// Get invoice by ID
// ---------------------------------------------------------------------------

describe("GET /api/billing/invoices/:id", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("returns invoice with line_items array", async () => {
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 100,
			}),
		);
		const { id } = await readJson(createRes);

		const res = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		expect(res.status).toBe(200);

		const invoice = await readJson(res);
		assertInvoiceShape(invoice, ["line_items"]);
		expect(invoice.id).toBe(id);
		expect(invoice.line_items).toEqual([]);
	});

	test("returns 404 for nonexistent ID", async () => {
		const res = await instance.app.fetch(
			req("/api/billing/invoices/does-not-exist"),
		);
		expect(res.status).toBe(404);

		const data = await readJson(res);
		expect(data).toEqual({ error: "Invoice not found" });
	});
});

// ---------------------------------------------------------------------------
// Update invoice
// ---------------------------------------------------------------------------

describe("PATCH /api/billing/invoices/:id", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("updates specific fields without touching others", async () => {
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 100,
				currency: "EUR",
			}),
		);
		const { id } = await readJson(createRes);

		const patchRes = await instance.app.fetch(
			patch(`/api/billing/invoices/${id}`, { status: "paid" }),
		);
		expect(patchRes.status).toBe(200);

		const updated = await readJson(patchRes);
		expect(updated.status).toBe("paid");
		expect(updated.amount).toBe(100); // unchanged
		expect(updated.currency).toBe("EUR"); // unchanged

		// Verify via GET
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		const fetched = await readJson(getRes);
		expect(fetched.status).toBe("paid");
		expect(fetched.amount).toBe(100);
	});

	test("returns 500 for nonexistent ID", async () => {
		const res = await instance.app.fetch(
			patch("/api/billing/invoices/nonexistent", { amount: 1 }),
		);
		// Kysely's executeTakeFirstOrThrow throws → 500
		expect(res.status).toBe(500);
	});

	test("rejects invalid status enum", async () => {
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 1,
			}),
		);
		const { id } = await readJson(createRes);

		const res = await instance.app.fetch(
			patch(`/api/billing/invoices/${id}`, { status: "invalid" }),
		);
		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// Delete invoice
// ---------------------------------------------------------------------------

describe("DELETE /api/billing/invoices/:id", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("removes an invoice and returns ok", async () => {
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 100,
			}),
		);
		const { id } = await readJson(createRes);

		const delRes = await instance.app.fetch(
			del(`/api/billing/invoices/${id}`),
		);
		expect(delRes.status).toBe(200);
		expect(await readJson(delRes)).toEqual({ ok: true });

		// Verify it's gone
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		expect(getRes.status).toBe(404);

		// List is empty
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const data = await readJson(listRes);
		expect(data.total).toBe(0);
	});

	test("deleting nonexistent ID succeeds silently", async () => {
		const res = await instance.app.fetch(
			del("/api/billing/invoices/nonexistent"),
		);
		expect(res.status).toBe(200);
		expect(await readJson(res)).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle (sequential flow in one test)
// ---------------------------------------------------------------------------

describe("full invoice lifecycle", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("create → list → update → get → delete → empty", async () => {
		// 1. Create
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "lifecycle",
				amount: 42,
			}),
		);
		expect(createRes.status).toBe(200);
		const created = await readJson(createRes);
		assertInvoiceShape(created);
		const id = created.id;

		// 2. List — exactly 1
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const listed = await readJson(listRes);
		expect(listed.total).toBe(1);
		expect(listed.invoices[0].id).toBe(id);

		// 3. Update
		const patchRes = await instance.app.fetch(
			patch(`/api/billing/invoices/${id}`, {
				status: "paid",
				amount: 84,
			}),
		);
		expect(patchRes.status).toBe(200);

		// 4. Get — reflects updates + has line_items
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		const fetched = await readJson(getRes);
		assertInvoiceShape(fetched, ["line_items"]);
		expect(fetched.status).toBe("paid");
		expect(fetched.amount).toBe(84);
		expect(fetched.line_items).toEqual([]);

		// 5. Delete
		const delRes = await instance.app.fetch(
			del(`/api/billing/invoices/${id}`),
		);
		expect(delRes.status).toBe(200);

		// 6. List — empty
		const finalList = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		expect(await readJson(finalList)).toEqual({ invoices: [], total: 0 });
	});
});

// ---------------------------------------------------------------------------
// Concurrent requests
// ---------------------------------------------------------------------------

describe("concurrent requests", () => {
	let instance: App;

	beforeEach(async () => {
		instance = await createApp();
	});
	afterEach(async () => {
		await instance.close();
	});

	test("10 parallel creates all succeed with unique IDs", async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				instance.app.fetch(
					post("/api/billing/invoices", {
						customer_id: `concurrent-${i}`,
						amount: i * 100,
					}),
				),
			),
		);

		expect(results.every((r) => r.status === 200)).toBe(true);

		const invoices = await Promise.all(
			results.map((r) => readJson(r)),
		);
		const ids = new Set(invoices.map((inv) => inv.id));
		expect(ids.size).toBe(10);

		// Verify total persisted
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const data = await readJson(listRes);
		expect(data.total).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// Service lifecycle
// ---------------------------------------------------------------------------

describe("service lifecycle", () => {
	test("shutdown tears down cleanly", async () => {
		const instance = await createApp();

		// Verify working before shutdown
		const res = await instance.app.fetch(req("/"));
		expect(res.status).toBe(200);

		await instance.close();

		// After close, DB operations should fail (connection closed)
		// Hono catches the error and returns 500, it doesn't throw
		const res2 = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "c1",
				amount: 1,
			}),
		);
		expect(res2.status).toBe(500);
	});

	test("service without db schema inits without a database", async () => {
		const noDbService = createService({
			id: "ping",
			version: "1.0.0",
			endpoints: () => ({}),
		});

		const svc = noDbService({ mount: "/ping" });

		// No dbSchema → no database needed → init resolves cleanly.
		await svc.init();
		expect(svc.id).toBe("ping");
		await svc.shutdown();
	});

	test("init rejects if service needs a db but none provided", () => {
		const dbService = createService({
			id: "needs-db",
			version: "1.0.0",
			dbSchema: {
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
			},
			endpoints: () => ({}),
		});

		const svc = dbService({ mount: "/x" });

		// dbSchema present but no `database` in config → init() rejects.
		expect(svc.init()).rejects.toThrow("no database connection");
	});
});
