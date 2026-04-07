import { Kysely, type Dialect, type KyselyConfig } from "kysely";

/**
 * Accepted connection types from the host.
 * The host passes one of these; we detect the dialect automatically.
 */
export type DatabaseConnection =
	| { dialect: Dialect }
	| { connectionString: string; type: "postgres" | "mysql" | "sqlite" }
	// biome-ignore lint/suspicious/noExplicitAny: accept any pool-like driver instance
	| { pool: any; type: "postgres" | "mysql" }
	// biome-ignore lint/suspicious/noExplicitAny: accept any sqlite database instance
	| { database: any; type: "sqlite" };

/**
 * Creates a Kysely instance from the host's connection configuration.
 *
 * For v0, we require the host to specify the type explicitly when passing
 * a pool or connection string. Dialect auto-detection from driver instances
 * can be added later (see open question #2 in the architecture doc).
 */
export function createKyselyInstance(
	connection: DatabaseConnection,
): Kysely<Record<string, unknown>> {
	if ("dialect" in connection) {
		return new Kysely({ dialect: connection.dialect });
	}

	// For connection strings and raw pools, we dynamically import the
	// appropriate Kysely dialect. This keeps driver packages as peer deps.
	const config = buildDialectConfig(connection);
	return new Kysely(config);
}

function buildDialectConfig(
	connection: Exclude<DatabaseConnection, { dialect: Dialect }>,
): KyselyConfig {
	if ("connectionString" in connection) {
		return buildFromConnectionString(connection.connectionString, connection.type);
	}

	if ("pool" in connection) {
		switch (connection.type) {
			case "postgres": {
				const { PostgresDialect } = require("kysely");
				return { dialect: new PostgresDialect({ pool: connection.pool }) };
			}
			case "mysql": {
				const { MysqlDialect } = require("kysely");
				return { dialect: new MysqlDialect({ pool: connection.pool }) };
			}
		}
	}

	if ("database" in connection) {
		const { SqliteDialect } = require("kysely");
		return { dialect: new SqliteDialect({ database: connection.database }) };
	}

	throw new Error("Invalid database connection configuration");
}

function buildFromConnectionString(
	connectionString: string,
	type: "postgres" | "mysql" | "sqlite",
): KyselyConfig {
	switch (type) {
		case "postgres": {
			const pg = require("pg");
			const { PostgresDialect } = require("kysely");
			const pool = new pg.Pool({ connectionString });
			return { dialect: new PostgresDialect({ pool }) };
		}
		case "mysql": {
			const mysql = require("mysql2");
			const { MysqlDialect } = require("kysely");
			const pool = mysql.createPool(connectionString);
			return { dialect: new MysqlDialect({ pool }) };
		}
		case "sqlite": {
			const Database = require("better-sqlite3");
			const { SqliteDialect } = require("kysely");
			const database = new Database(connectionString);
			return { dialect: new SqliteDialect({ database }) };
		}
	}
}
