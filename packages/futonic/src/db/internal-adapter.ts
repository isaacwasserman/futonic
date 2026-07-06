/**
 * Internal database adapter that scopes all queries to a service's prefixed tables.
 *
 * Follows the same 8-method interface as better-auth's Kysely adapter
 * (`create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`).
 *
 * Access tables via property name: `db.invoices.create({ ... })`.
 */

import type {
	ExpressionBuilder,
	ExpressionWrapper,
	Kysely,
	SqlBool,
} from "kysely";
import { type ServiceDBSchema, prefixTableName } from "./schema";

export interface Where {
	field: string;
	value: unknown;
	operator?: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "not_in";
	connector?: "AND" | "OR";
}

export type FilterOp =
	| "eq"
	| "ne"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "not_in"
	| "contains"
	| "startsWith"
	| "endsWith"
	| "isNull"
	| "isNotNull";

export type FilterNode =
	| { type: "and" | "or"; nodes: FilterNode[] }
	| { type: "not"; node: FilterNode }
	| { type: "cond"; field: string; op: FilterOp; value?: unknown };

export interface FindManyOptions {
	where?: Where[];
	/** Boolean expression tree (supports and/or/not + contains/like); combined with `where`. */
	filter?: FilterNode;
	/** Column projection; when omitted selects all columns. */
	select?: string[];
	limit?: number;
	offset?: number;
	sortBy?: { field: string; direction: "asc" | "desc" };
}

export interface TableAdapter {
	create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
	findOne(where: Where[]): Promise<Record<string, unknown> | null>;
	findMany(options?: FindManyOptions): Promise<Record<string, unknown>[]>;
	count(
		where?: Where[] | { where?: Where[]; filter?: FilterNode },
	): Promise<number>;
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
function applyWhere<
	T extends { where(ref: string, op: string, val: unknown): T },
>(query: T, where: Where[]): T {
	for (const condition of where) {
		const { field, value, operator = "eq" } = condition;

		switch (operator) {
			case "eq":
				query =
					value === null
						? query.where(field, "is", null as never)
						: query.where(field, "=", value as never);
				break;
			case "ne":
				query =
					value === null
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

/**
 * Recursively compiles a FilterNode boolean expression tree into a Kysely
 * expression, using the query's ExpressionBuilder for and/or/not composition.
 */
function buildFilter(
	eb: ExpressionBuilder<Record<string, unknown>, string>,
	node: FilterNode | undefined,
): ExpressionWrapper<Record<string, unknown>, string, SqlBool> {
	if (!node) return eb.lit(true) as never;
	switch (node.type) {
		case "and":
			return (
				node.nodes.length
					? eb.and(node.nodes.map((n) => buildFilter(eb, n)))
					: eb.lit(true)
			) as never;
		case "or":
			return (
				node.nodes.length
					? eb.or(node.nodes.map((n) => buildFilter(eb, n)))
					: eb.lit(false)
			) as never;
		case "not":
			return eb.not(buildFilter(eb, node.node)) as never;
		case "cond": {
			const { field, op, value } = node;
			const c = (sqlOp: string, val: unknown) =>
				eb(field as never, sqlOp as never, val as never) as never;
			switch (op) {
				case "eq":
					return value === null ? c("is", null) : c("=", value);
				case "ne":
					return value === null ? c("is not", null) : c("<>", value);
				case "gt":
					return c(">", value);
				case "gte":
					return c(">=", value);
				case "lt":
					return c("<", value);
				case "lte":
					return c("<=", value);
				case "in":
					return c("in", value);
				case "not_in":
					return c("not in", value);
				case "contains":
					return c("like", `%${value}%`);
				case "startsWith":
					return c("like", `${value}%`);
				case "endsWith":
					return c("like", `%${value}`);
				case "isNull":
					return c("is", null);
				case "isNotNull":
					return c("is not", null);
				default:
					throw new Error(`Unsupported filter op: ${op}`);
			}
		}
		default:
			throw new Error(
				`Unknown filter node type: ${(node as { type: string }).type}`,
			);
	}
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
			let query = options?.select?.length
				? kysely.selectFrom(tableName).select(options.select as never)
				: kysely.selectFrom(tableName).selectAll();

			if (options?.where) {
				query = applyWhere(query as never, options.where) as typeof query;
			}

			if (options?.filter) {
				query = query.where((eb) =>
					buildFilter(eb as never, options.filter),
				) as typeof query;
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

			const whereArr = Array.isArray(where) ? where : where?.where;
			const filter = Array.isArray(where) ? undefined : where?.filter;

			if (whereArr) {
				query = applyWhere(query as never, whereArr) as typeof query;
			}

			if (filter) {
				query = query.where((eb) =>
					buildFilter(eb as never, filter),
				) as typeof query;
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
