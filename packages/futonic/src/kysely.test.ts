import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import type { ServiceDBSchema } from "./db-schema";
import { createKysely, type DatabaseConnection } from "./kysely";
import { createSqliteConnection } from "./test-helpers";

test("returns a Kysely bound to the sqlite connection that runs queries", async () => {
	const db = createKysely<ServiceDBSchema>(createSqliteConnection(), "sqlite");
	expect(db).toBeInstanceOf(Kysely);

	await sql`create table t (id text primary key, n integer)`.execute(db);
	await sql`insert into t (id, n) values ('a', 1), ('b', 2)`.execute(db);
	const result =
		await sql<{ id: string; n: number }>`select id, n from t order by id`.execute(
			db,
		);

	expect(result.rows).toEqual([
		{ id: "a", n: 1 },
		{ id: "b", n: 2 },
	]);

	await db.destroy();
});

test("CamelCasePlugin maps camelCase queries to snake_case columns", async () => {
	// biome-ignore lint/suspicious/noExplicitAny: ad-hoc table for the test
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

test("each provider selects a distinct dialect", () => {
	// Dialect selection only; no queries, so a stub connection is fine here.
	const stub = {} as unknown as DatabaseConnection;
	const pg = createKysely<ServiceDBSchema>(stub, "pg");
	const mysql = createKysely<ServiceDBSchema>(stub, "mysql");
	const sqlite = createKysely<ServiceDBSchema>(stub, "sqlite");

	// biome-ignore lint/suspicious/noExplicitAny: reaching into the executor for the test
	const dialectName = (db: Kysely<any>) =>
		// biome-ignore lint/suspicious/noExplicitAny: reaching into the executor for the test
		(db as any).getExecutor().adapter.constructor.name;

	expect(dialectName(pg)).not.toBe(dialectName(mysql));
	expect(dialectName(mysql)).not.toBe(dialectName(sqlite));
	expect(dialectName(pg)).not.toBe(dialectName(sqlite));
});
