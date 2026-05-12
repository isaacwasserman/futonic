import { type Middleware, createEndpoint } from "better-call";
import { z } from "zod";
import { type SupportEndpointCtx, jsonResponse, nowIso } from "./common";

const STATUS = ["open", "pending", "resolved", "closed"] as const;
const PRIORITY = ["low", "normal", "high", "urgent"] as const;

export function createAdminEndpoints(use: Middleware[]) {
	const listAllTickets = createEndpoint(
		"/admin/tickets",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx } = (ctx as unknown as SupportEndpointCtx).context;
			const url = new URL((ctx as { request: Request }).request.url);

			const filters: { field: string; value: unknown }[] = [];
			const status = url.searchParams.get("status");
			const customerId = url.searchParams.get("customer_id");
			const assigneeId = url.searchParams.get("assignee_id");
			if (status) filters.push({ field: "status", value: status });
			if (customerId) filters.push({ field: "customer_id", value: customerId });
			if (assigneeId) filters.push({ field: "assignee_id", value: assigneeId });

			const where = filters.length > 0 ? filters : undefined;
			const tickets = await serviceCtx.db.tickets.findMany({
				where,
				sortBy: { field: "updated_at", direction: "desc" },
			});
			const total = await serviceCtx.db.tickets.count(where);

			return { tickets, total };
		},
	);

	const getAnyTicket = createEndpoint(
		"/admin/tickets/:id",
		{ method: "GET", use },
		async (ctx) => {
			const { serviceCtx } = (ctx as unknown as SupportEndpointCtx).context;
			const { id } = ctx.params as { id: string };

			const ticket = await serviceCtx.db.tickets.findOne([
				{ field: "id", value: id },
			]);
			if (!ticket) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const comments = await serviceCtx.db.ticket_comments.findMany({
				where: [{ field: "ticket_id", value: id }],
				sortBy: { field: "created_at", direction: "asc" },
			});

			return { ...ticket, comments };
		},
	);

	const addAdminComment = createEndpoint(
		"/admin/tickets/:id/comments",
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
			if (!ticket) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const ts = nowIso();
			const comment = await serviceCtx.db.ticket_comments.create({
				id: crypto.randomUUID(),
				ticket_id: id,
				author_id: auth.id,
				author_role: "admin",
				body: ctx.body.body,
				created_at: ts,
			});

			// An admin reply on an `open` ticket flips it to `pending`
			// (waiting on the customer).
			const nextStatus = ticket.status === "open" ? "pending" : ticket.status;
			await serviceCtx.db.tickets.update([{ field: "id", value: id }], {
				status: nextStatus,
				updated_at: ts,
			});

			return comment;
		},
	);

	const patchTicket = createEndpoint(
		"/admin/tickets/:id",
		{
			method: "PATCH",
			use,
			body: z
				.object({
					status: z.enum(STATUS).optional(),
					priority: z.enum(PRIORITY).optional(),
					assignee_id: z.string().nullable().optional(),
				})
				.refine((d) => Object.keys(d).length > 0, {
					message: "At least one field is required",
				}),
		},
		async (ctx) => {
			const { serviceCtx } = (ctx as unknown as SupportEndpointCtx).context;
			const { id } = ctx.params as { id: string };

			const ticket = await serviceCtx.db.tickets.findOne([
				{ field: "id", value: id },
			]);
			if (!ticket) {
				return jsonResponse(404, { error: "Ticket not found" });
			}

			const ts = nowIso();
			const patch: Record<string, unknown> = { updated_at: ts };
			const body = ctx.body;

			if (body.status !== undefined) {
				patch.status = body.status;
				// Manage closed_at alongside status transitions.
				if (body.status === "closed" && ticket.status !== "closed") {
					patch.closed_at = ts;
				} else if (body.status !== "closed" && ticket.status === "closed") {
					patch.closed_at = null;
				}
			}
			if (body.priority !== undefined) patch.priority = body.priority;
			if (body.assignee_id !== undefined) patch.assignee_id = body.assignee_id;

			const updated = await serviceCtx.db.tickets.update(
				[{ field: "id", value: id }],
				patch,
			);

			return updated;
		},
	);

	return {
		listAllTickets,
		getAnyTicket,
		addAdminComment,
		patchTicket,
	};
}
