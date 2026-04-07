/**
 * Internal database adapter that scopes all queries to a service's prefixed tables.
 *
 * Follows the same 8-method interface as better-auth's Kysely adapter
 * (`create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`).
 *
 * Access tables via property name: `db.invoices.create({ ... })`.
 */

import type { Kysely } from "kysely";
import { prefixTableName, type ServiceDBSchema } from "./schema";

export interface Where {
	field: string;
	value: unknown;
	operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in";
	connector?: "AND" | "OR";
}

export interface FindManyOptions {
	where?: Where[];
	limit?: number;
	offset?: number;
	sortBy?: { field: string; direction: "asc" | "desc" };
}

export interface TableAdapter {
	create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
	findOne(where: Where[]): Promise<Record<string, unknown> | null>;
	findMany(options?: FindManyOptions): Promise<Record<string, unknown>[]>;
	count(where?: Where[]): Promise<number>;
	update(
		where: Where[],
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	updateMany(where: Where[], data: Record<string, unknown>): Promise<number>;
	delete(where: Where[]): Promise<void>;
	deleteMany(where: Where[]): Promise<number>;
}

/**
 * Proxy-based adapter that scopes all queries to a service's prefixed tables.
 */
export type InternalAdapter<TSchema extends ServiceDBSchema = ServiceDBSchema> =
	{
		[K in keyof TSchema["tables"]]: TableAdapter;
	};

export function createInternalAdapter<TSchema extends ServiceDBSchema>(
	kysely: Kysely<Record<string, unknown>>,
	serviceId: string,
	schema?: TSchema,
): InternalAdapter<TSchema> {
	const allowedTables = new Set(schema ? Object.keys(schema.tables) : []);

	return new Proxy({} as InternalAdapter<TSchema>, {
		get(_target, prop: string) {
			if (!allowedTables.has(prop)) {
				throw new Error(
					`Service "${serviceId}" does not have a table named "${prop}"`,
				);
			}

			const prefixed = prefixTableName(serviceId, prop);
			return createTableAdapter(kysely, prefixed);
		},
	});
}

/**
 * Applies a Where[] clause to a Kysely query builder.
 * Forked from better-auth's `convertWhereClause` pattern.
 */
function applyWhere<T extends { where(ref: string, op: string, val: unknown): T }>(
	query: T,
	where: Where[],
): T {
	for (const condition of where) {
		const { field, value, operator = "eq" } = condition;

		switch (operator) {
			case "eq":
				query = value === null
					? query.where(field, "is", null as never)
					: query.where(field, "=", value as never);
				break;
			case "ne":
				query = value === null
					? query.where(field, "is not", null as never)
					: query.where(field, "<>", value as never);
				break;
			case "gt":
				query = query.where(field, ">", value as never);
				break;
			case "gte":
				query = query.where(field, ">=", value as never);
				break;
			case "lt":
				query = query.where(field, "<", value as never);
				break;
			case "lte":
				query = query.where(field, "<=", value as never);
				break;
			case "in":
				query = query.where(field, "in", value as never);
				break;
			case "not_in":
				query = query.where(field, "not in", value as never);
				break;
		}
	}
	return query;
}

function createTableAdapter(
	kysely: Kysely<Record<string, unknown>>,
	tableName: string,
): TableAdapter {
	return {
		async create(data) {
			const result = await kysely
				.insertInto(tableName)
				.values(data)
				.returningAll()
				.executeTakeFirstOrThrow();
			return result as Record<string, unknown>;
		},

		async findOne(where) {
			let query = kysely.selectFrom(tableName).selectAll();
			query = applyWhere(query as never, where) as typeof query;
			const result = await query.executeTakeFirst();
			return (result as Record<string, unknown>) ?? null;
		},

		async findMany(options) {
			let query = kysely.selectFrom(tableName).selectAll();

			if (options?.where) {
				query = applyWhere(query as never, options.where) as typeof query;
			}

			if (options?.sortBy) {
				query = query.orderBy(
					options.sortBy.field as never,
					options.sortBy.direction,
				);
			}

			if (options?.limit !== undefined) {
				query = query.limit(options.limit);
			}

			if (options?.offset !== undefined) {
				query = query.offset(options.offset);
			}

			return (await query.execute()) as Record<string, unknown>[];
		},

		async count(where) {
			let query = kysely
				.selectFrom(tableName)
				.select(kysely.fn.count("id" as never).as("count"));

			if (where) {
				query = applyWhere(query as never, where) as typeof query;
			}

			const res = await query.execute();
			const count = (res[0] as Record<string, unknown>)?.count;
			if (typeof count === "number") return count;
			if (typeof count === "bigint") return Number(count);
			return Number.parseInt(count as string);
		},

		async update(where, data) {
			let query = kysely.updateTable(tableName).set(data);
			query = applyWhere(query as never, where) as typeof query;
			const result = await query.returningAll().executeTakeFirstOrThrow();
			return result as Record<string, unknown>;
		},

		async updateMany(where, data) {
			let query = kysely.updateTable(tableName).set(data);
			query = applyWhere(query as never, where) as typeof query;
			const res = (await query.executeTakeFirst()).numUpdatedRows;
			return res > Number.MAX_SAFE_INTEGER
				? Number.MAX_SAFE_INTEGER
				: Number(res);
		},

		async delete(where) {
			let query = kysely.deleteFrom(tableName);
			query = applyWhere(query as never, where) as typeof query;
			await query.execute();
		},

		async deleteMany(where) {
			let query = kysely.deleteFrom(tableName);
			query = applyWhere(query as never, where) as typeof query;
			const res = (await query.executeTakeFirst()).numDeletedRows;
			return res > Number.MAX_SAFE_INTEGER
				? Number.MAX_SAFE_INTEGER
				: Number(res);
		},
	};
}
