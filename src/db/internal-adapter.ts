import type { Kysely } from "kysely";
import { prefixTableName, type ServiceDBSchema } from "./schema";

export interface FindManyOptions {
	where?: Record<string, unknown>;
	limit?: number;
	offset?: number;
	orderBy?: { field: string; direction: "asc" | "desc" };
}

export interface TableAdapter {
	findMany(options?: FindManyOptions): Promise<Record<string, unknown>[]>;
	findOne(where: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
	update(
		where: Record<string, unknown>,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	delete(where: Record<string, unknown>): Promise<void>;
}

/**
 * Proxy-based adapter that scopes all queries to a service's prefixed tables.
 * Access tables via property name: `db.invoices.findMany()`.
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
	const allowedTables = new Set(
		schema ? Object.keys(schema.tables) : [],
	);

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

function createTableAdapter(
	kysely: Kysely<Record<string, unknown>>,
	tableName: string,
): TableAdapter {
	return {
		async findMany(options?: FindManyOptions) {
			let query = kysely.selectFrom(tableName).selectAll();

			if (options?.where) {
				for (const [key, value] of Object.entries(options.where)) {
					query = query.where(key as never, "=", value as never);
				}
			}

			if (options?.orderBy) {
				query = query.orderBy(
					options.orderBy.field as never,
					options.orderBy.direction,
				);
			}

			if (options?.limit) {
				query = query.limit(options.limit);
			}

			if (options?.offset) {
				query = query.offset(options.offset);
			}

			return (await query.execute()) as Record<string, unknown>[];
		},

		async findOne(where: Record<string, unknown>) {
			let query = kysely.selectFrom(tableName).selectAll();
			for (const [key, value] of Object.entries(where)) {
				query = query.where(key as never, "=", value as never);
			}
			const result = await query.executeTakeFirst();
			return (result as Record<string, unknown>) ?? null;
		},

		async create(data: Record<string, unknown>) {
			const result = await kysely
				.insertInto(tableName)
				.values(data)
				.returningAll()
				.executeTakeFirstOrThrow();
			return result as Record<string, unknown>;
		},

		async update(
			where: Record<string, unknown>,
			data: Record<string, unknown>,
		) {
			let query = kysely.updateTable(tableName).set(data);
			for (const [key, value] of Object.entries(where)) {
				query = query.where(key as never, "=", value as never);
			}
			const result = await query.returningAll().executeTakeFirstOrThrow();
			return result as Record<string, unknown>;
		},

		async delete(where: Record<string, unknown>) {
			let query = kysely.deleteFrom(tableName);
			for (const [key, value] of Object.entries(where)) {
				query = query.where(key as never, "=", value as never);
			}
			await query.execute();
		},
	};
}
