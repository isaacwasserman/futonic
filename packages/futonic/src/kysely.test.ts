import { expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { Kysely, sql } from "kysely";
import type { ServiceDBSchema } from "./db-schema";
import { generateDrizzleSchema } from "./drizzle";
import {
	type DatabaseConnection,
	type KyselyFromServiceDBSchema,
	createKysely,
} from "./kysely";
import { createSqliteConnection } from "./test-helpers";

test("returns a Kysely bound to the sqlite connection that runs queries", async () => {
	const db = createKysely<ServiceDBSchema>(createSqliteConnection(), "sqlite");
	expect(db).toBeInstanceOf(Kysely);

	await sql`create table t (id text primary key, n integer)`.execute(db);
	await sql`insert into t (id, n) values ('a', 1), ('b', 2)`.execute(db);
	const result = await sql<{
		id: string;
		n: number;
	}>`select id, n from t order by id`.execute(db);

	expect(result.rows).toEqual([
		{ id: "a", n: 1 },
		{ id: "b", n: 2 },
	]);

	await db.destroy();
});

test("CamelCasePlugin maps camelCase queries to snake_case columns", async () => {
	const db = createKysely<ServiceDBSchema>(
		createSqliteConnection(),
		"sqlite",
	) as unknown as Kysely<any>;

	await sql`create table users (id integer primary key, full_name text)`.execute(
		db,
	);

	// Query builder uses camelCase; the plugin rewrites it to snake_case SQL.
	await db.insertInto("users").values({ id: 1, fullName: "Ada" }).execute();
	const row = await db
		.selectFrom("users")
		.select(["id", "fullName"])
		.executeTakeFirstOrThrow();

	expect(row).toEqual({ id: 1, fullName: "Ada" });

	await db.destroy();
});

test("prefixed camelCase keys resolve to the prefixed physical table", async () => {
	// The Drizzle generator names physical tables `${prefix}_${name}`; the Kysely
	// schema exposes the matching `${prefix}${Capitalize<key>}` key. This proves
	// the two agree: a query written against the typed key reaches the real table.
	const serviceSchema = {
		tables: {
			tickets: {
				name: "tickets",
				columns: {
					id: { type: "integer", primaryKey: true },
					fullName: { type: "string" },
				},
			},
		},
	} as const satisfies ServiceDBSchema;

	const drizzle = generateDrizzleSchema({
		serviceSchema,
		dialect: "sqlite",
		prefix: "ticketing",
	});
	const physicalName = getTableName(drizzle.ticketingTickets);
	expect(physicalName).toBe("ticketing_tickets");

	const db = createKysely<typeof serviceSchema, "ticketing">(
		createSqliteConnection(),
		"sqlite",
	);
	await sql
		.raw(
			`create table ${physicalName} (id integer primary key, full_name text)`,
		)
		.execute(db);

	// The key is `ticketingTickets` (prefixed) and typed; the CamelCasePlugin
	// rewrites it to the `ticketing_tickets` physical table.
	await db
		.insertInto("ticketingTickets")
		.values({ id: 1, fullName: "Ada" })
		.execute();
	const row = await db
		.selectFrom("ticketingTickets")
		.select(["id", "fullName"])
		.executeTakeFirstOrThrow();
	expect(row).toEqual({ id: 1, fullName: "Ada" });

	await db.destroy();
});

test("the Kysely schema is keyed only by the prefixed name", () => {
	type Schema = {
		tables: { tickets: { name: "tickets"; columns: Record<string, never> } };
	};
	// Extract the schema's table keys from the Kysely instance's DB type.
	type Keys = KyselyFromServiceDBSchema<Schema, "ticketing"> extends Kysely<
		infer DB
	>
		? keyof DB
		: never;

	const prefixed: Keys = "ticketingTickets";
	expect(prefixed).toBe("ticketingTickets");

	// The bare logical name is NOT a valid key — this must not compile.
	// @ts-expect-error the schema is keyed by the prefixed name only
	const bare: Keys = "tickets";
	expect(bare).toBeDefined();
});

test("each provider selects a distinct dialect", () => {
	// Dialect selection only; no queries, so a stub connection is fine here.
	const stub = {} as unknown as DatabaseConnection;
	const pg = createKysely<ServiceDBSchema>(stub, "pg");
	const mysql = createKysely<ServiceDBSchema>(stub, "mysql");
	const sqlite = createKysely<ServiceDBSchema>(stub, "sqlite");

	const dialectName = (db: Kysely<any>) =>
		(db as any).getExecutor().adapter.constructor.name;

	expect(dialectName(pg)).not.toBe(dialectName(mysql));
	expect(dialectName(mysql)).not.toBe(dialectName(sqlite));
	expect(dialectName(pg)).not.toBe(dialectName(sqlite));
});
