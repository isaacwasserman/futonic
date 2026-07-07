import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { generateSchema } from "./drizzle";
import type { ServiceDBSchema } from "./schema";

const schema: ServiceDBSchema = {
	tables: {
		users: {
			fields: {
				id: { type: "string", primaryKey: true },
				age: { type: "number", required: true, defaultValue: 0 },
			},
		},
		posts: {
			fields: {
				id: { type: "string", primaryKey: true },
				author: {
					type: "string",
					references: { model: "users", field: "id", onDelete: "set-null" },
				},
				body: { type: "json" },
				created: { type: "date" },
				flag: { type: "boolean" },
				data: { type: "binary" },
			},
		},
	},
};

function sqlTypes(table: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, col] of Object.entries(getTableColumns(table as never))) {
		out[name] = (col as { getSQLType(): string }).getSQLType();
	}
	return out;
}

describe("generateSchema", () => {
	test("returns a record keyed by logical table names", () => {
		const tables = generateSchema(schema, "postgres", "billing");
		expect(Object.keys(tables).sort()).toEqual(["posts", "users"]);
	});

	test("maps postgres field types to postgres column types", () => {
		const { posts } = generateSchema(schema, "postgres", "billing");
		expect(sqlTypes(posts)).toEqual({
			id: "text",
			author: "text",
			body: "jsonb",
			created: "timestamp",
			flag: "boolean",
			data: "bytea",
		});
	});

	test("maps mysql field types to mysql column types", () => {
		const { posts } = generateSchema(schema, "mysql", "billing");
		expect(sqlTypes(posts)).toEqual({
			id: "text",
			author: "text",
			body: "json",
			created: "datetime",
			flag: "boolean",
			data: "blob",
		});
	});

	test("maps sqlite field types to sqlite column types", () => {
		const { posts } = generateSchema(schema, "sqlite", "billing");
		expect(sqlTypes(posts)).toEqual({
			id: "text",
			author: "text",
			body: "text",
			created: "integer",
			flag: "integer",
			data: "blob",
		});
	});

	test("prefixes SQL table names with the service id", () => {
		expect(
			getTableName(
				generateSchema(schema, "postgres", "billing").users as never,
			),
		).toBe("billing_users");
	});

	test("wires foreign keys across generated tables", () => {
		const { posts } = generateSchema(schema, "postgres", "billing");
		const { foreignKeys } = getTableConfig(posts as never);
		expect(foreignKeys).toHaveLength(1);
		const ref = foreignKeys[0].reference();
		expect(getTableName(ref.foreignTable)).toBe("billing_users");
		expect(ref.foreignColumns.map((c) => c.name)).toEqual(["id"]);
		expect(foreignKeys[0].onDelete).toBe("set null");
	});

	test("throws on an unknown dialect", () => {
		expect(() => generateSchema(schema, "oracle" as never, "billing")).toThrow(
			/Unsupported dialect/,
		);
	});

	test("throws when a reference targets a missing table", () => {
		const bad: ServiceDBSchema = {
			tables: {
				posts: {
					fields: {
						author: {
							type: "string",
							references: { model: "ghost", field: "id" },
						},
					},
				},
			},
		};
		const { posts } = generateSchema(bad, "postgres", "billing");
		// The reference thunk resolves lazily; force it via the foreign key.
		const { foreignKeys } = getTableConfig(posts as never);
		expect(() => foreignKeys[0].reference()).toThrow(/unknown table "ghost"/);
	});
});

// --- Type-level inference (compile-time, verified via `tsc`) ---------------

// Exact type equality: fails to compile if A and B differ.
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
	? 1
	: 2
	? true
	: false;

// A literal schema so field types/flags survive as literals for inference.
const typedSchema = {
	tables: {
		users: {
			fields: {
				id: { type: "string", primaryKey: true },
				name: { type: "string", required: true },
				age: { type: "number" },
				active: { type: "boolean", required: true },
				created: { type: "date", required: true },
				avatar: { type: "binary" },
			},
		},
	},
} satisfies ServiceDBSchema;

type PgUsers = ReturnType<
	typeof generateSchema<typeof typedSchema, "postgres", "billing">
>["users"]["$inferSelect"];

// Primary keys and `required` fields are non-null; others are nullable.
type _pgId = Expect<Equal<PgUsers["id"], string>>;
type _pgName = Expect<Equal<PgUsers["name"], string>>;
type _pgAge = Expect<Equal<PgUsers["age"], number | null>>;
type _pgActive = Expect<Equal<PgUsers["active"], boolean>>;
type _pgCreated = Expect<Equal<PgUsers["created"], Date>>;
type _pgAvatar = Expect<Equal<PgUsers["avatar"], Buffer | null>>;

// SQLite maps boolean/date to JS boolean/Date via column modes.
type SqliteUsers = ReturnType<
	typeof generateSchema<typeof typedSchema, "sqlite", "billing">
>["users"]["$inferSelect"];
type _sqliteActive = Expect<Equal<SqliteUsers["active"], boolean>>;
type _sqliteCreated = Expect<Equal<SqliteUsers["created"], Date>>;
