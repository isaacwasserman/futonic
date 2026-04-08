import type { ServiceDBSchema } from "futonic";

export const billingSchema = {
	tables: {
		invoices: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				customer_id: { type: "string", required: true },
				amount: { type: "number", required: true },
				currency: { type: "string", required: true },
				status: {
					type: "string",
					required: true,
					enum: ["draft", "sent", "paid", "void"],
				},
				due_date: { type: "string" },
				created_at: { type: "string", required: true },
			},
		},
		line_items: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				invoice_id: {
					type: "string",
					required: true,
					references: {
						model: "invoices",
						field: "id",
						onDelete: "cascade",
					},
				},
				description: { type: "string", required: true },
				quantity: { type: "number", required: true },
				unit_price: { type: "number", required: true },
			},
		},
	},
} satisfies ServiceDBSchema;

export type BillingSchema = typeof billingSchema;
