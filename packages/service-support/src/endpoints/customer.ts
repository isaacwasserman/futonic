import { type Middleware, createEndpoint } from "better-call";
import { z } from "zod";
import { type SupportEndpointCtx, jsonResponse, nowIso } from "./common";

const PRIORITY = ["low", "normal", "high", "urgent"] as const;

export function createCustomerEndpoints(use: Middleware[]) {
	const openTicket = createEndpoint(
		"/tickets",
		{
			method: "POST",
			use,
			body: z.object({
				subject: z.string().min(1),
				message: z.string().min(1),
				priority: z.enum(PRIORITY).default("normal"),
			}),
		},
		async (ctx) => {
			const { serviceCtx, auth } = (ctx as unknown as SupportEndpointCtx)
				.context;

			if (auth.role !== "customer") {
				return jsonResponse(403, {
					error: "Only customers may open tickets via this route",
				});
			}

			const body = ctx.body;
			const ts = nowIso();
			const ticketId = crypto.randomUUID();

			const ticket = await serviceCtx.db.tickets.create({
				id: ticketId,
				customer_id: auth.id,
				subject: body.subject,
				status: "open",
				priority: body.priority ?? "normal",
				assignee_id: null,
				created_at: ts,
				updated_at: ts,
				closed_at: null,
			});

			await serviceCtx.db.ticket_comments.create({
				id: crypto.randomUUID(),
				ticket_id: ticketId,
				author_id: auth.id,
				author_role: "customer",
				body: body.message,
				created_at: ts,
			});

			serviceCtx.logger.info(`Ticket opened: ${ticketId} by ${auth.id}`);
			return ticket;
		},
	);

	const listOwnTickets = createEndpoint(
		"/tickets",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx, auth } = (ctx as unknown as SupportEndpointCtx)
				.context;

			const url = new URL((ctx as { request: Request }).request.url);
			const status = url.searchParams.get("status");

			const where = [
				{ field: "customer_id" as const, value: auth.id },
				...(status ? [{ field: "status" as const, value: status }] : []),
			];

			const tickets = await serviceCtx.db.tickets.findMany({
				where,
				sortBy: { field: "updated_at", direction: "desc" },
			});
			const total = await serviceCtx.db.tickets.count(where);

			return { tickets, total };
		},
	);

	const getOwnTicket = createEndpoint(
		"/tickets/:id",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx, auth } = (ctx as unknown as SupportEndpointCtx)
				.context;
			const { id } = ctx.params as { id: string };

			const ticket = await serviceCtx.db.tickets.findOne([
				{ field: "id", value: id },
			]);

			// 404 (not 403) to avoid leaking the existence of other customers' tickets.
			if (
				!ticket ||
				(auth.role === "customer" && ticket.customer_id !== auth.id)
			) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const comments = await serviceCtx.db.ticket_comments.findMany({
				where: [{ field: "ticket_id", value: id }],
				sortBy: { field: "created_at", direction: "asc" },
			});

			return { ...ticket, comments };
		},
	);

	const addOwnComment = createEndpoint(
		"/tickets/:id/comments",
		{
			method: "POST",
			use,
			body: z.object({ body: z.string().min(1) }),
		},
		async (ctx) => {
			const { serviceCtx, auth } = (ctx as unknown as SupportEndpointCtx)
				.context;
			const { id } = ctx.params as { id: string };

			const ticket = await serviceCtx.db.tickets.findOne([
				{ field: "id", value: id },
			]);

			if (
				!ticket ||
				(auth.role === "customer" && ticket.customer_id !== auth.id)
			) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const ts = nowIso();
			const comment = await serviceCtx.db.ticket_comments.create({
				id: crypto.randomUUID(),
				ticket_id: id,
				author_id: auth.id,
				author_role: "customer",
				body: ctx.body.body,
				created_at: ts,
			});

			// A customer reply moves a `pending` ticket back into `open`
			// so it re-enters the staff queue.
			const nextStatus = ticket.status === "pending" ? "open" : ticket.status;
			await serviceCtx.db.tickets.update([{ field: "id", value: id }], {
				status: nextStatus,
				updated_at: ts,
			});

			return comment;
		},
	);

	const closeOwnTicket = createEndpoint(
		"/tickets/:id/close",
		{ method: "POST", use },
		async (ctx) => {
			const { serviceCtx, auth } = (ctx as unknown as SupportEndpointCtx)
				.context;
			const { id } = ctx.params as { id: string };

			const ticket = await serviceCtx.db.tickets.findOne([
				{ field: "id", value: id },
			]);

			if (
				!ticket ||
				(auth.role === "customer" && ticket.customer_id !== auth.id)
			) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const ts = nowIso();
			const updated = await serviceCtx.db.tickets.update(
				[{ field: "id", value: id }],
				{ status: "closed", updated_at: ts, closed_at: ts },
			);

			return updated;
		},
	);

	return {
		openTicket,
		listOwnTickets,
		getOwnTicket,
		addOwnComment,
		closeOwnTicket,
	};
}
