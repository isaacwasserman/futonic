import type { ServiceDBSchema } from "futonic";

export const supportSchema = {
	tables: {
		tickets: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				customer_id: { type: "string", required: true },
				subject: { type: "string", required: true },
				status: {
					type: "string",
					required: true,
					enum: ["open", "pending", "resolved", "closed"],
				},
				priority: {
					type: "string",
					required: true,
					enum: ["low", "normal", "high", "urgent"],
				},
				assignee_id: { type: "string" },
				created_at: { type: "string", required: true },
				updated_at: { type: "string", required: true },
				closed_at: { type: "string" },
			},
		},
		ticket_comments: {
			fields: {
				id: { type: "string", primaryKey: true, required: true },
				ticket_id: {
					type: "string",
					required: true,
					references: {
						model: "tickets",
						field: "id",
						onDelete: "cascade",
					},
				},
				author_id: { type: "string", required: true },
				author_role: {
					type: "string",
					required: true,
					enum: ["customer", "admin"],
				},
				body: { type: "string", required: true },
				created_at: { type: "string", required: true },
			},
		},
	},
} satisfies ServiceDBSchema;

export type SupportSchema = typeof supportSchema;
