/**
 * Host-level e2e tests for the support service.
 *
 * Verifies that the support service is wired through the Hono host correctly:
 * header-based identification reaches the auth middleware, both customer
 * and admin flows are reachable at their mounted paths, and billing routes
 * still work in parallel.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "./app";

let instance: App;

beforeEach(async () => {
	instance = await createApp();
});
afterEach(async () => {
	await instance.close();
});

function req(path: string, init?: RequestInit) {
	return new Request(`http://localhost${path}`, init);
}

function customerJson(id: string, body: unknown): RequestInit {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-user-id": id,
			"x-user-role": "customer",
		},
		body: JSON.stringify(body),
	};
}

function adminGet(): RequestInit {
	return { headers: { "x-user-id": "staff-1", "x-user-role": "admin" } };
}

describe("support service host wiring", () => {
	test("missing headers on /api/support/tickets → 401", async () => {
		const res = await instance.app.fetch(
			req("/api/support/tickets", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ subject: "x", message: "y" }),
			}),
		);
		expect(res.status).toBe(401);
	});

	test("customer opens a ticket and reads it back through Hono", async () => {
		const openRes = await instance.app.fetch(
			req(
				"/api/support/tickets",
				customerJson("cust-1", { subject: "broken", message: "help" }),
			),
		);
		expect(openRes.status).toBe(200);
		const ticket = (await openRes.json()) as any;
		expect(ticket.customer_id).toBe("cust-1");
		expect(ticket.status).toBe("open");

		const listRes = await instance.app.fetch(
			req("/api/support/tickets", {
				headers: { "x-user-id": "cust-1", "x-user-role": "customer" },
			}),
		);
		const list = (await listRes.json()) as any;
		expect(list.total).toBe(1);
		expect(list.tickets[0].id).toBe(ticket.id);
	});

	test("customer cannot reach the admin route", async () => {
		const res = await instance.app.fetch(
			req("/api/support/admin/tickets", {
				headers: { "x-user-id": "cust-1", "x-user-role": "customer" },
			}),
		);
		expect(res.status).toBe(403);
	});

	test("admin sees all tickets across customers", async () => {
		await instance.app.fetch(
			req(
				"/api/support/tickets",
				customerJson("cust-1", { subject: "a", message: "1" }),
			),
		);
		await instance.app.fetch(
			req(
				"/api/support/tickets",
				customerJson("cust-2", { subject: "b", message: "2" }),
			),
		);

		const res = await instance.app.fetch(
			req("/api/support/admin/tickets", adminGet()),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.total).toBe(2);
	});

	test("billing routes remain unaffected by the new service", async () => {
		const res = await instance.app.fetch(
			req("/api/billing/invoices", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customer_id: "cust-1", amount: 100 }),
			}),
		);
		expect(res.status).toBe(200);
		const invoice = (await res.json()) as any;
		expect(invoice.customer_id).toBe("cust-1");
	});
});
