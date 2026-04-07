/**
 * End-to-end tests for the host-hono + service-billing stack.
 *
 * Each describe block gets a fresh in-memory SQLite database via createApp().
 * Tests call app.fetch() directly — the full Hono → better-call →
 * futonic → billing service → SQLite stack is exercised, just without TCP.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createApp, type App } from "./app";

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

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

describe("health check", () => {
	let instance: App;

	beforeAll(async () => {
		instance = await createApp();
	});
	afterAll(async () => {
		await instance.close();
	});

	test("GET / returns status and mounted services", async () => {
		const res = await instance.app.fetch(req("/"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.status).toBe("ok");
		expect(data.services).toEqual(["billing"]);
	});
});

// ---------------------------------------------------------------------------
// Invoice CRUD
// ---------------------------------------------------------------------------

describe("invoice CRUD", () => {
	let instance: App;

	beforeAll(async () => {
		instance = await createApp();
	});
	afterAll(async () => {
		await instance.close();
	});

	test("POST /api/billing/invoices creates an invoice with defaults", async () => {
		const res = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "cust-1",
				amount: 100,
			}),
		);
		expect(res.status).toBe(200);

		const invoice = await res.json();
		expect(invoice.id).toBeString();
		expect(invoice.customer_id).toBe("cust-1");
		expect(invoice.amount).toBe(100);
		expect(invoice.currency).toBe("USD");
		expect(invoice.status).toBe("draft");
		expect(invoice.created_at).toBeString();
	});

	test("POST /api/billing/invoices accepts explicit fields", async () => {
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

		const invoice = await res.json();
		expect(invoice.currency).toBe("EUR");
		expect(invoice.status).toBe("sent");
		expect(invoice.due_date).toBe("2026-12-31");
	});

	test("GET /api/billing/invoices lists all invoices", async () => {
		const res = await instance.app.fetch(req("/api/billing/invoices"));
		expect(res.status).toBe(200);

		const data = await res.json();
		expect(data.total).toBe(2);
		expect(data.invoices).toHaveLength(2);
		// Sorted by created_at desc — most recent first
		expect(data.invoices[0].customer_id).toBe("cust-2");
	});

	test("GET /api/billing/invoices?status=draft filters by status", async () => {
		const res = await instance.app.fetch(
			req("/api/billing/invoices?status=draft"),
		);
		const data = await res.json();
		expect(data.total).toBe(1);
		expect(data.invoices[0].status).toBe("draft");
	});

	test("GET /api/billing/invoices/:id returns invoice with line_items", async () => {
		// Grab an ID from the list
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const { invoices } = await listRes.json();
		const id = invoices[0].id;

		const res = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		expect(res.status).toBe(200);

		const invoice = await res.json();
		expect(invoice.id).toBe(id);
		expect(invoice.line_items).toBeArray();
	});

	test("GET /api/billing/invoices/:id returns 404 for nonexistent", async () => {
		const res = await instance.app.fetch(
			req("/api/billing/invoices/nonexistent"),
		);
		expect(res.status).toBe(404);

		const data = await res.json();
		expect(data.error).toBe("Invoice not found");
	});

	test("PATCH /api/billing/invoices/:id updates an invoice", async () => {
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices?status=draft"),
		);
		const { invoices } = await listRes.json();
		const id = invoices[0].id;

		const res = await instance.app.fetch(
			patch(`/api/billing/invoices/${id}`, {
				status: "paid",
				amount: 999,
			}),
		);
		expect(res.status).toBe(200);

		const updated = await res.json();
		expect(updated.status).toBe("paid");
		expect(updated.amount).toBe(999);

		// Verify persistence
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		const fetched = await getRes.json();
		expect(fetched.status).toBe("paid");
		expect(fetched.amount).toBe(999);
	});

	test("DELETE /api/billing/invoices/:id removes an invoice", async () => {
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const { invoices } = await listRes.json();
		const id = invoices[0].id;
		const countBefore = invoices.length;

		const delRes = await instance.app.fetch(
			del(`/api/billing/invoices/${id}`),
		);
		expect(delRes.status).toBe(200);
		const body = await delRes.json();
		expect(body.ok).toBe(true);

		// Verify it's gone
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		expect(getRes.status).toBe(404);

		// Total count decreased
		const listRes2 = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const data = await listRes2.json();
		expect(data.total).toBe(countBefore - 1);
	});
});

// ---------------------------------------------------------------------------
// Full lifecycle (isolated instance)
// ---------------------------------------------------------------------------

describe("full invoice lifecycle", () => {
	let instance: App;

	beforeAll(async () => {
		instance = await createApp();
	});
	afterAll(async () => {
		await instance.close();
	});

	test("create → list → update → get → delete → empty", async () => {
		// 1. Create
		const createRes = await instance.app.fetch(
			post("/api/billing/invoices", {
				customer_id: "lifecycle-cust",
				amount: 42,
			}),
		);
		expect(createRes.status).toBe(200);
		const created = await createRes.json();
		const id = created.id;

		// 2. List — should have exactly 1
		const listRes = await instance.app.fetch(
			req("/api/billing/invoices"),
		);
		const listed = await listRes.json();
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

		// 4. Get — reflects updates
		const getRes = await instance.app.fetch(
			req(`/api/billing/invoices/${id}`),
		);
		const fetched = await getRes.json();
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
		const finalData = await finalList.json();
		expect(finalData.total).toBe(0);
		expect(finalData.invoices).toEqual([]);
	});
});
