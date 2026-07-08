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

test("a bare logical query hits the prefixed physical table at runtime", async () => {
	// The Drizzle generator names physical tables `${prefix}_${name}`; the caller
	// queries the bare logical name and the TablePrefixPlugin rewrites it to that
	// physical name. Multi-word names exercise the CamelCase + prefix ordering.
	const serviceSchema = {
		tables: {
			ticketEvents: {
				name: "ticket_events",
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
	const physicalName = getTableName(drizzle.ticketingTicketEvents);
	expect(physicalName).toBe("ticketing_ticket_events");

	const db = createKysely<typeof serviceSchema>(
		createSqliteConnection(),
		"sqlite",
		"ticketing",
	);
	await sql
		.raw(
			`create table ${physicalName} (id integer primary key, full_name text)`,
		)
		.execute(db);

	await db
		.insertInto("ticketEvents")
		.values({ id: 1, fullName: "Ada" })
		.execute();
	const row = await db
		.selectFrom("ticketEvents")
		.select(["id", "fullName"])
		.executeTakeFirstOrThrow();
	expect(row).toEqual({ id: 1, fullName: "Ada" });

	await db.destroy();
});

test("without a prefix, table names are left unchanged", async () => {
	const db = createKysely<ServiceDBSchema>(createSqliteConnection(), "sqlite");
	await sql`create table tickets (id integer primary key)`.execute(db);

	// No prefix plugin, so the bare name maps straight through.
	await (db as unknown as Kysely<any>)
		.insertInto("tickets")
		.values({ id: 1 })
		.execute();
	const row = await (db as unknown as Kysely<any>)
		.selectFrom("tickets")
		.select("id")
		.executeTakeFirstOrThrow();
	expect(row).toEqual({ id: 1 });

	await db.destroy();
});

test("the Kysely schema is keyed by the bare logical name", () => {
	type Schema = {
		tables: {
			ticketEvents: { name: "ticket_events"; columns: Record<string, never> };
		};
	};
	// Extract the schema's table keys from the Kysely instance's DB type.
	type Keys = KyselyFromServiceDBSchema<Schema> extends Kysely<infer DB>
		? keyof DB
		: never;

	const logical: Keys = "ticketEvents";
	expect(logical).toBe("ticketEvents");

	// The prefixed name is NOT a key — the prefix is applied at runtime, not here.
	// @ts-expect-error the schema is keyed by the bare logical name
	const prefixed: Keys = "ticketingTicketEvents";
	expect(prefixed).toBeDefined();
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
