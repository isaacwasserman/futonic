import { expect, test } from "bun:test";
import type {
	ColumnDefinition,
	ServiceDBSchema,
	TableDefinition,
} from "./db-schema";

// db-schema is a types-only module; these assertions exercise the type shapes
// via `satisfies` (compile-time) plus a trivial runtime check.

test("a valid schema conforms to the schema types", () => {
	const idColumn = {
		type: "string",
		primaryKey: true,
	} satisfies ColumnDefinition;

	const statusColumn = {
		type: "enum",
		enumValues: ["open", "closed"],
		optional: true,
	} satisfies ColumnDefinition;

	const table = {
		name: "tickets",
		columns: { id: idColumn, status: statusColumn },
	} satisfies TableDefinition;

	const schema = { tables: { tickets: table } } satisfies ServiceDBSchema;

	expect(schema.tables.tickets.name).toBe("tickets");
	expect(schema.tables.tickets.columns.id.primaryKey).toBe(true);
	expect(schema.tables.tickets.columns.status.enumValues).toEqual([
		"open",
		"closed",
	]);
});

test("a column can declare a foreign-key reference", () => {
	const column = {
		type: "string",
		references: { table: "tickets", column: "id", onDelete: "cascade" },
	} satisfies ColumnDefinition;

	expect(column.references.onDelete).toBe("cascade");
});
