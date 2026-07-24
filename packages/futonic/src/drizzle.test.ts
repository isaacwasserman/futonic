import { expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { generateDrizzleSchema, generateStorageDrizzleSchema } from "./drizzle";
import { drizzleFor } from "./test-helpers";

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
		drizzle: drizzleFor("sqlite"),
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
		drizzle: drizzleFor("sqlite"),
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
		drizzle: drizzleFor("pg"),
	});

	// Tables come back as the host's base table type (precise column types
	// can't survive cross-version decoupling), so assert the columns are present
	// at runtime rather than via typed property access.
	const columns = getTableColumns(tables.svcTickets);
	expect(Object.keys(columns).sort()).toEqual([
		"details",
		"id",
		"status",
		"title",
	]);
});

test("generates for every dialect, including enums and references", () => {
	const pg = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "pg",
		prefix: "svc",
		drizzle: drizzleFor("pg"),
	});
	const mysql = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "mysql",
		prefix: "svc",
		drizzle: drizzleFor("mysql"),
	});
	const sqlite = generateDrizzleSchema({
		serviceSchema: schema,
		dialect: "sqlite",
		prefix: "sqlitesvc",
		drizzle: drizzleFor("sqlite"),
	});
	expect(getTableName(pg.svcTickets)).toBe("svc_tickets");
	expect(getTableName(mysql.svcTicketEvents)).toBe("svc_ticket_events");
	expect(getTableName(sqlite.sqlitesvcTickets)).toBe("sqlitesvc_tickets");
});

test("generateStorageDrizzleSchema builds the shared owner-scoped storage table", () => {
	const schema = generateStorageDrizzleSchema("sqlite", drizzleFor("sqlite"));
	expect(getTableName(schema.futonicStorageObjects)).toBe(
		"futonic_storage_objects",
	);
	expect(
		Object.keys(getTableColumns(schema.futonicStorageObjects)).sort(),
	).toEqual(["contentType", "createdAt", "data", "key", "owner", "size"]);
});
