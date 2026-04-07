import { describe, expect, test } from "bun:test";
import { detectDatabaseType } from "./kysely-factory";

describe("detectDatabaseType", () => {
	test("detects postgres from pg.Pool shape", () => {
		// pg.Pool has a `connect` method
		const mockPool = { connect: () => {}, query: () => {} };
		expect(detectDatabaseType(mockPool)).toBe("postgres");
	});

	test("detects mysql from mysql2 pool shape", () => {
		// mysql2 pool has a `getConnection` method
		const mockPool = { getConnection: () => {} };
		expect(detectDatabaseType(mockPool)).toBe("mysql");
	});

	test("detects sqlite from better-sqlite3 shape", () => {
		// better-sqlite3 has an `aggregate` method
		const mockDb = { aggregate: () => {}, prepare: () => {} };
		expect(detectDatabaseType(mockDb)).toBe("sqlite");
	});

	test("detects sqlite from Bun SQLite shape", () => {
		const mockDb = { fileControl: () => {} };
		expect(detectDatabaseType(mockDb)).toBe("sqlite");
	});

	test("detects sqlite from node:sqlite shape", () => {
		const mockDb = { open: () => {}, close: () => {}, prepare: () => {} };
		expect(detectDatabaseType(mockDb)).toBe("sqlite");
	});

	test("detects sqlite from D1 shape", () => {
		const mockDb = { batch: () => {}, exec: () => {}, prepare: () => {} };
		expect(detectDatabaseType(mockDb)).toBe("sqlite");
	});

	test("returns null for unknown shapes", () => {
		expect(detectDatabaseType({})).toBe(null);
		expect(detectDatabaseType(null)).toBe(null);
		expect(detectDatabaseType(undefined)).toBe(null);
	});
});
