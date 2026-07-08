import {
	CamelCasePlugin,
	type Dialect,
	Kysely,
	type KyselyPlugin,
	MysqlDialect,
	type MysqlPool,
	OperationNodeTransformer,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	PostgresDialect,
	type PostgresPool,
	type QueryResult,
	type RootOperationNode,
	type SqliteDatabase,
	SqliteDialect,
	type TableNode,
	type UnknownRow,
} from "kysely";
import type {
	ColumnDefinition,
	ServiceDBSchema,
	TableDefinition,
} from "./db-schema";

type ScalarColumnType<C extends ColumnDefinition> = C["type"] extends "string"
	? string
	: C["type"] extends "integer"
		? number
		: C["type"] extends "boolean"
			? boolean
			: C["type"] extends "timestamp"
				? Date
				: C["type"] extends "json"
					? unknown
					: C["type"] extends "blob"
						? Uint8Array
						: C["type"] extends "enum"
							? C["enumValues"] extends readonly (infer E)[]
								? E
								: string
							: never;

type ColumnValueType<C extends ColumnDefinition> = C["optional"] extends true
	? ScalarColumnType<C> | null
	: ScalarColumnType<C>;

type RowType<T extends TableDefinition> = {
	[K in keyof T["columns"]]: ColumnValueType<T["columns"][K]>;
};

/**
 * The Kysely schema is keyed by the schema's *logical* (camelCase) table keys —
 * the same names the caller writes, e.g. `db.selectFrom("ticketEvents")`.
 */
type KyselySchema<S extends ServiceDBSchema> = {
	[TableName in keyof S["tables"]]: RowType<S["tables"][TableName]>;
};

export type KyselyFromServiceDBSchema<S extends ServiceDBSchema> = Kysely<
	KyselySchema<S>
>;

/**
 * Rewrites every table reference to `${prefix}_${table}`, matching the physical
 * names the Drizzle generator produces. Installed after `CamelCasePlugin`, so it
 * sees (and prepends to) the already-snake_cased identifier.
 */
class TablePrefixTransformer extends OperationNodeTransformer {
	readonly #prefix: string;

	constructor(prefix: string) {
		super();
		this.#prefix = prefix;
	}

	protected override transformTable(node: TableNode): TableNode {
		const transformed = super.transformTable(node);
		return {
			...transformed,
			table: {
				...transformed.table,
				identifier: {
					...transformed.table.identifier,
					name: `${this.#prefix}_${transformed.table.identifier.name}`,
				},
			},
		};
	}
}

/** A Kysely plugin that prefixes table names via {@link TablePrefixTransformer}. */
class TablePrefixPlugin implements KyselyPlugin {
	readonly #transformer: TablePrefixTransformer;

	constructor(prefix: string) {
		this.#transformer = new TablePrefixTransformer(prefix);
	}

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		return this.#transformer.transformNode(args.node);
	}

	transformResult(
		args: PluginTransformResultArgs,
	): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

/**
 * Which driver family the raw connection belongs to. Selects the Kysely dialect
 * (and therefore which member of `DatabaseConnection` is expected).
 */
export type DatabaseProvider = "pg" | "mysql" | "sqlite";

/**
 * The raw driver connection the caller passes in, per provider (each is one of
 * Kysely's own driver interfaces, so no concrete driver package is required):
 *   - `pg`     → `PostgresPool`   (e.g. node-postgres `Pool`)
 *   - `mysql`  → `MysqlPool`      (e.g. mysql2 `Pool`)
 *   - `sqlite` → `SqliteDatabase` (any better-sqlite3-compatible database)
 */
export type DatabaseConnection = PostgresPool | MysqlPool | SqliteDatabase;

/** Build a typed Kysely instance for a provider. */
export function createKysely<TDBSchema extends ServiceDBSchema>(
	connection: DatabaseConnection,
	provider: DatabaseProvider,
	prefix?: string,
): KyselyFromServiceDBSchema<TDBSchema> {
	let dialect: Dialect;
	switch (provider) {
		case "pg":
			dialect = new PostgresDialect({ pool: connection as PostgresPool });
			break;
		case "mysql":
			dialect = new MysqlDialect({ pool: connection as MysqlPool });
			break;
		case "sqlite":
			dialect = new SqliteDialect({ database: connection as SqliteDatabase });
			break;
	}

	const plugins = prefix
		? [new CamelCasePlugin(), new TablePrefixPlugin(prefix)]
		: [new CamelCasePlugin()];

	return new Kysely({
		dialect,
		plugins,
	}) as KyselyFromServiceDBSchema<TDBSchema>;
}
