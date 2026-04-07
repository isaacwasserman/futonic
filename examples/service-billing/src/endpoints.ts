import { createEndpoint, type Middleware } from "better-call";
import { z } from "zod";
import type { ServiceContext } from "futonic";
import type { BillingSchema } from "./schema";

/**
 * All endpoints receive the ServiceContext via middleware injected at mount time.
 * We type-narrow it here for convenience.
 */
type Ctx = { context: { serviceCtx: ServiceContext<BillingSchema> } };

/**
 * Creates all billing endpoints with the given middleware array.
 * This is called at mount time once the host has provided a ServiceContext.
 */
export function createBillingEndpoints(use: Middleware[]) {
	const listInvoices = createEndpoint(
		"/invoices",
		{ method: "GET", use },
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			const url = new URL(ctx.request!.url);
			const status = url.searchParams.get("status");

			const where = status
				? [{ field: "status" as const, value: status }]
				: undefined;

			const invoices = await svc.db.invoices.findMany({
				where,
				sortBy: { field: "created_at", direction: "desc" },
			});
			const total = await svc.db.invoices.count(where);

			return { invoices, total };
		},
	);

	const getInvoice = createEndpoint(
		"/invoices/:id",
		{ method: "GET", use },
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			const { id } = ctx.params as { id: string };

			const invoice = await svc.db.invoices.findOne([
				{ field: "id", value: id },
			]);

			if (!invoice) {
				return new Response(
					JSON.stringify({ error: "Invoice not found" }),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const lineItems = await svc.db.line_items.findMany({
				where: [{ field: "invoice_id", value: id }],
			});

			return { ...invoice, line_items: lineItems };
		},
	);

	const createInvoice = createEndpoint(
		"/invoices",
		{
			method: "POST",
			use,
			body: z.object({
				customer_id: z.string(),
				amount: z.number(),
				currency: z.string().default("USD"),
				status: z
					.enum(["draft", "sent", "paid", "void"])
					.default("draft"),
				due_date: z.string().optional(),
			}),
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			const body = ctx.body;

			const invoice = await svc.db.invoices.create({
				id: crypto.randomUUID(),
				customer_id: body.customer_id,
				amount: body.amount,
				currency: body.currency ?? "USD",
				status: body.status ?? "draft",
				due_date: body.due_date ?? null,
				created_at: new Date().toISOString(),
			});

			svc.logger.info(`Invoice created: ${invoice.id}`);
			return invoice;
		},
	);

	const updateInvoice = createEndpoint(
		"/invoices/:id",
		{
			method: "PATCH",
			use,
			body: z.object({
				amount: z.number().optional(),
				status: z
					.enum(["draft", "sent", "paid", "void"])
					.optional(),
				due_date: z.string().optional(),
			}),
		},
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			const { id } = ctx.params as { id: string };
			const body = ctx.body;

			const data: Record<string, unknown> = {};
			if (body.amount !== undefined) data.amount = body.amount;
			if (body.status !== undefined) data.status = body.status;
			if (body.due_date !== undefined) data.due_date = body.due_date;

			const updated = await svc.db.invoices.update(
				[{ field: "id", value: id }],
				data,
			);

			svc.logger.info(`Invoice updated: ${id}`);
			return updated;
		},
	);

	const deleteInvoice = createEndpoint(
		"/invoices/:id",
		{ method: "DELETE", use },
		async (ctx) => {
			const svc = (ctx as unknown as Ctx).context.serviceCtx;
			const { id } = ctx.params as { id: string };

			await svc.db.invoices.delete([{ field: "id", value: id }]);
			svc.logger.info(`Invoice deleted: ${id}`);

			return { ok: true };
		},
	);

	return {
		listInvoices,
		getInvoice,
		createInvoice,
		updateInvoice,
		deleteInvoice,
	};
}
