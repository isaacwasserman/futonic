import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { generateDrizzleSchema } from "./drizzle";

const schema = {
	tables: {
		tickets: {
			name: "tickets",
			columns: {
				id: { type: "string", primaryKey: true },
				title: { type: "string" },
				details: { type: "string", optional: true },
				status: { type: "enum", enumValues: ["open", "closed"] },
			},
		},
		ticketEvents: {
			name: "ticket_events",
			columns: {
				id: { type: "string", primaryKey: true },
				ticketId: {
					type: "string",
					references: { table: "tickets", column: "id", onDelete: "cascade" },
				},
			},
		},
	},
} as const;

test("record keys are prefixed and capitalized", () => {
	const tables = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "sqlite",
		prefix: "ticketing",
	});

	expect(Object.keys(tables).sort()).toEqual([
		"ticketingTicketEvents",
		"ticketingTickets",
	]);
});

test("SQL table names are prefixed with the service id", () => {
	const tables = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "sqlite",
		prefix: "ticketing",
	});

	expect(getTableName(tables.ticketingTickets)).toBe("ticketing_tickets");
	expect(getTableName(tables.ticketingTicketEvents)).toBe(
		"ticketing_ticket_events",
	);
});

test("generated tables expose their columns", () => {
	const tables = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "pg",
		prefix: "svc",
	});

	const t = tables.svcTickets;
	expect(t.id).toBeDefined();
	expect(t.title).toBeDefined();
	expect(t.details).toBeDefined();
	expect(t.status).toBeDefined();
});

test("generates for every dialect, including enums and references", () => {
	for (const dialect of ["pg", "mysql", "sqlite"] as const) {
		const tables = generateDrizzleSchema({
			serviceSchema: schema,
			dialect,
			prefix: "svc",
		});
		expect(getTableName(tables.svcTickets)).toBe("svc_tickets");
		expect(getTableName(tables.svcTicketEvents)).toBe("svc_ticket_events");
	}
});
