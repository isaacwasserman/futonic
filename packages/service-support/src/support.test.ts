/**
 * End-to-end tests for service-support.
 *
 * Each test gets a fresh in-memory SQLite + futonic host via
 * createSupportTestApp(), so no test depends on another. Tests drive the
 * service through the same router the host would mount — we exercise
 * middleware composition, validation, ownership checks, and status flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type SupportTestApp,
	asUser,
	createSupportTestApp,
	json,
	req,
} from "./test-utils";

let app: SupportTestApp;

beforeEach(async () => {
	app = await createSupportTestApp();
});
afterEach(async () => {
	await app.close();
});

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("auth gate", () => {
	test("missing headers → 401", async () => {
		const res = await app.fetch(
			req("/api/support/tickets", json({ subject: "x", message: "y" })),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as any;
		expect(body.message).toBe("Unauthenticated");
	});

	test("invalid role header → 401", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json(
					{ subject: "x", message: "y" },
					{
						"x-user-id": "u1",
						"x-user-role": "manager",
					},
				),
			),
		);
		expect(res.status).toBe(401);
	});

	test("missing x-user-id → 401", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "x", message: "y" }, { "x-user-role": "customer" }),
			),
		);
		expect(res.status).toBe(401);
	});
});

// ---------------------------------------------------------------------------
// Customer flow
// ---------------------------------------------------------------------------

describe("customer flow", () => {
	test("open → list → get → reply → close", async () => {
		const headers = asUser("cust-1", "customer");

		// Open
		const openRes = await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "Login broken", message: "Cannot sign in" }, headers),
			),
		);
		expect(openRes.status).toBe(200);
		const ticket = (await openRes.json()) as any;
		expect(ticket.customer_id).toBe("cust-1");
		expect(ticket.status).toBe("open");
		expect(ticket.priority).toBe("normal");
		expect(ticket.assignee_id).toBeNull();
		expect(ticket.closed_at).toBeNull();
		const ticketId = ticket.id;
		const openedAt = ticket.updated_at;

		// List
		const listRes = await app.fetch(req("/api/support/tickets", { headers }));
		const listed = (await listRes.json()) as any;
		expect(listed.total).toBe(1);
		expect(listed.tickets[0].id).toBe(ticketId);

		// Get includes initial comment
		const getRes = await app.fetch(
			req(`/api/support/tickets/${ticketId}`, { headers }),
		);
		const fetched = (await getRes.json()) as any;
		expect(fetched.id).toBe(ticketId);
		expect(fetched.comments).toHaveLength(1);
		expect(fetched.comments[0].body).toBe("Cannot sign in");
		expect(fetched.comments[0].author_role).toBe("customer");

		// Small delay so updated_at can advance
		await new Promise((r) => setTimeout(r, 5));

		// Reply
		const replyRes = await app.fetch(
			req(
				`/api/support/tickets/${ticketId}/comments`,
				json({ body: "Still broken" }, headers),
			),
		);
		expect(replyRes.status).toBe(200);

		const afterReply = await app
			.fetch(req(`/api/support/tickets/${ticketId}`, { headers }))
			.then((r) => r.json() as any);
		expect(afterReply.comments).toHaveLength(2);
		expect(afterReply.updated_at > openedAt).toBe(true);
		expect(afterReply.status).toBe("open"); // unchanged

		// Close
		const closeRes = await app.fetch(
			req(`/api/support/tickets/${ticketId}/close`, {
				method: "POST",
				headers,
			}),
		);
		expect(closeRes.status).toBe(200);
		const closed = (await closeRes.json()) as any;
		expect(closed.status).toBe("closed");
		expect(typeof closed.closed_at).toBe("string");
	});

	test("customer reply on pending ticket flips status back to open", async () => {
		const customer = asUser("cust-1", "customer");
		const admin = asUser("staff-1", "admin");

		const opened = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "x", message: "y" }, customer),
				),
			)
			.then((r) => r.json() as any);

		// Admin replies → status becomes 'pending'
		await app.fetch(
			req(
				`/api/support/admin/tickets/${opened.id}/comments`,
				json({ body: "Have you tried turning it off and on?" }, admin),
			),
		);

		const afterAdmin = await app
			.fetch(req(`/api/support/admin/tickets/${opened.id}`, { headers: admin }))
			.then((r) => r.json() as any);
		expect(afterAdmin.status).toBe("pending");

		// Customer replies → status flips back to 'open'
		await app.fetch(
			req(
				`/api/support/tickets/${opened.id}/comments`,
				json({ body: "Yes, didn't help" }, customer),
			),
		);

		const afterCustomer = await app
			.fetch(req(`/api/support/tickets/${opened.id}`, { headers: customer }))
			.then((r) => r.json() as any);
		expect(afterCustomer.status).toBe("open");
	});

	test("supports priority on creation", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json(
					{ subject: "x", message: "y", priority: "high" },
					asUser("cust-1", "customer"),
				),
			),
		);
		const ticket = (await res.json()) as any;
		expect(ticket.priority).toBe("high");
	});

	test("admin cannot open tickets via the customer route", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "x", message: "y" }, asUser("staff-1", "admin")),
			),
		);
		expect(res.status).toBe(403);
	});

	test("filter own tickets by status", async () => {
		const customer = asUser("cust-1", "customer");
		const t1 = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "a", message: "1" }, customer),
				),
			)
			.then((r) => r.json() as any);
		await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "b", message: "2" }, customer),
			),
		);
		await app.fetch(
			req(`/api/support/tickets/${t1.id}/close`, {
				method: "POST",
				headers: customer,
			}),
		);

		const open = await app
			.fetch(req("/api/support/tickets?status=open", { headers: customer }))
			.then((r) => r.json() as any);
		expect(open.total).toBe(1);

		const closed = await app
			.fetch(req("/api/support/tickets?status=closed", { headers: customer }))
			.then((r) => r.json() as any);
		expect(closed.total).toBe(1);
		expect(closed.tickets[0].id).toBe(t1.id);
	});
});

// ---------------------------------------------------------------------------
// Customer isolation
// ---------------------------------------------------------------------------

describe("customer isolation", () => {
	test("customer B cannot see or touch customer A's ticket", async () => {
		const a = asUser("cust-a", "customer");
		const b = asUser("cust-b", "customer");

		const aTicket = await app
			.fetch(
				req("/api/support/tickets", json({ subject: "x", message: "y" }, a)),
			)
			.then((r) => r.json() as any);

		// B's list is empty
		const bList = await app
			.fetch(req("/api/support/tickets", { headers: b }))
			.then((r) => r.json() as any);
		expect(bList.total).toBe(0);

		// B gets 404 on A's ticket
		const getRes = await app.fetch(
			req(`/api/support/tickets/${aTicket.id}`, { headers: b }),
		);
		expect(getRes.status).toBe(404);

		// B cannot reply to A's ticket
		const replyRes = await app.fetch(
			req(
				`/api/support/tickets/${aTicket.id}/comments`,
				json({ body: "hi" }, b),
			),
		);
		expect(replyRes.status).toBe(404);

		// B cannot close A's ticket
		const closeRes = await app.fetch(
			req(`/api/support/tickets/${aTicket.id}/close`, {
				method: "POST",
				headers: b,
			}),
		);
		expect(closeRes.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Admin flow
// ---------------------------------------------------------------------------

describe("admin flow", () => {
	test("customer hitting admin route → 403", async () => {
		const res = await app.fetch(
			req("/api/support/admin/tickets", {
				headers: asUser("cust-1", "customer"),
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as any;
		expect(body.message).toBe("Forbidden");
	});

	test("admin lists all tickets across customers", async () => {
		await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "a", message: "1" }, asUser("u1", "customer")),
			),
		);
		await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "b", message: "2" }, asUser("u2", "customer")),
			),
		);

		const res = await app.fetch(
			req("/api/support/admin/tickets", { headers: asUser("s1", "admin") }),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as any;
		expect(data.total).toBe(2);
	});

	test("admin filters by status / customer_id / assignee_id", async () => {
		const admin = asUser("s1", "admin");
		const u1 = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "a", message: "1" }, asUser("u1", "customer")),
				),
			)
			.then((r) => r.json() as any);
		await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "b", message: "2" }, asUser("u2", "customer")),
			),
		);

		// Assign u1's ticket to s1 and close it
		await app.fetch(
			req(`/api/support/admin/tickets/${u1.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", ...admin },
				body: JSON.stringify({ assignee_id: "s1", status: "closed" }),
			}),
		);

		const byCustomer = await app
			.fetch(
				req("/api/support/admin/tickets?customer_id=u1", { headers: admin }),
			)
			.then((r) => r.json() as any);
		expect(byCustomer.total).toBe(1);
		expect(byCustomer.tickets[0].id).toBe(u1.id);

		const byStatus = await app
			.fetch(
				req("/api/support/admin/tickets?status=closed", { headers: admin }),
			)
			.then((r) => r.json() as any);
		expect(byStatus.total).toBe(1);
		expect(byStatus.tickets[0].id).toBe(u1.id);

		const byAssignee = await app
			.fetch(
				req("/api/support/admin/tickets?assignee_id=s1", { headers: admin }),
			)
			.then((r) => r.json() as any);
		expect(byAssignee.total).toBe(1);

		const noMatch = await app
			.fetch(
				req("/api/support/admin/tickets?assignee_id=nobody", {
					headers: admin,
				}),
			)
			.then((r) => r.json() as any);
		expect(noMatch.total).toBe(0);
	});

	test("admin reply on open ticket flips status to pending", async () => {
		const t = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "x", message: "y" }, asUser("u1", "customer")),
				),
			)
			.then((r) => r.json() as any);

		const admin = asUser("s1", "admin");
		const res = await app.fetch(
			req(
				`/api/support/admin/tickets/${t.id}/comments`,
				json({ body: "Looking into it" }, admin),
			),
		);
		expect(res.status).toBe(200);
		const comment = (await res.json()) as any;
		expect(comment.author_role).toBe("admin");
		expect(comment.author_id).toBe("s1");

		const after = await app
			.fetch(req(`/api/support/admin/tickets/${t.id}`, { headers: admin }))
			.then((r) => r.json() as any);
		expect(after.status).toBe("pending");
	});

	test("PATCH manages closed_at on status transitions", async () => {
		const t = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "x", message: "y" }, asUser("u1", "customer")),
				),
			)
			.then((r) => r.json() as any);

		const admin = asUser("s1", "admin");

		// → closed: sets closed_at
		const toClosed = await app
			.fetch(
				req(`/api/support/admin/tickets/${t.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", ...admin },
					body: JSON.stringify({ status: "closed" }),
				}),
			)
			.then((r) => r.json() as any);
		expect(toClosed.status).toBe("closed");
		expect(typeof toClosed.closed_at).toBe("string");

		// → open again: clears closed_at
		const reopened = await app
			.fetch(
				req(`/api/support/admin/tickets/${t.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", ...admin },
					body: JSON.stringify({ status: "open" }),
				}),
			)
			.then((r) => r.json() as any);
		expect(reopened.status).toBe("open");
		expect(reopened.closed_at).toBeNull();
	});

	test("PATCH with empty body → 400", async () => {
		const t = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "x", message: "y" }, asUser("u1", "customer")),
				),
			)
			.then((r) => r.json() as any);

		const res = await app.fetch(
			req(`/api/support/admin/tickets/${t.id}`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					...asUser("s1", "admin"),
				},
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PATCH against nonexistent ticket → 404", async () => {
		const res = await app.fetch(
			req("/api/support/admin/tickets/nope", {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					...asUser("s1", "admin"),
				},
				body: JSON.stringify({ status: "resolved" }),
			}),
		);
		expect(res.status).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validation", () => {
	test("empty subject → 400", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "", message: "y" }, asUser("cust-1", "customer")),
			),
		);
		expect(res.status).toBe(400);
	});

	test("missing message → 400", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json({ subject: "x" }, asUser("cust-1", "customer")),
			),
		);
		expect(res.status).toBe(400);
	});

	test("invalid priority enum → 400", async () => {
		const res = await app.fetch(
			req(
				"/api/support/tickets",
				json(
					{ subject: "x", message: "y", priority: "extreme" },
					asUser("cust-1", "customer"),
				),
			),
		);
		expect(res.status).toBe(400);
	});

	test("empty comment body → 400", async () => {
		const t = await app
			.fetch(
				req(
					"/api/support/tickets",
					json({ subject: "x", message: "y" }, asUser("cust-1", "customer")),
				),
			)
			.then((r) => r.json() as any);

		const res = await app.fetch(
			req(
				`/api/support/tickets/${t.id}/comments`,
				json({ body: "" }, asUser("cust-1", "customer")),
			),
		);
		expect(res.status).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// Host-supplied identifyUser
// ---------------------------------------------------------------------------

describe("host-supplied identifyUser", () => {
	test("custom identification scheme works", async () => {
		// A host that uses a single 'authorization' header.
		const customApp = await createSupportTestApp({
			identifyUser: (headers) => {
				const value = headers.get("authorization");
				if (!value) return null;
				const [id, role] = value.split(":");
				if (!id || (role !== "customer" && role !== "admin")) return null;
				return { id, role };
			},
		});

		try {
			const ok = await customApp.fetch(
				req("/api/support/tickets", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						authorization: "u1:customer",
					},
					body: JSON.stringify({ subject: "x", message: "y" }),
				}),
			);
			expect(ok.status).toBe(200);

			const forbidden = await customApp.fetch(
				req("/api/support/admin/tickets", {
					headers: { authorization: "u1:customer" },
				}),
			);
			expect(forbidden.status).toBe(403);

			const admin = await customApp.fetch(
				req("/api/support/admin/tickets", {
					headers: { authorization: "s1:admin" },
				}),
			);
			expect(admin.status).toBe(200);

			const unauth = await customApp.fetch(req("/api/support/admin/tickets"));
			expect(unauth.status).toBe(401);
		} finally {
			await customApp.close();
		}
	});
});
