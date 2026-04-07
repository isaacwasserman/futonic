/**
 * Generator types for CLI schema generation.
 *
 * Forked from better-auth `packages/cli/src/generators/types.ts` (MIT).
 * Adapted to use futonic's ServiceDBSchema IR instead of BetterAuthOptions.
 */

import type { PrefixedTable } from "../../db/schema";

export interface SchemaGeneratorResult {
	code?: string;
	fileName: string;
	overwrite?: boolean;
	append?: boolean;
}

export type DatabaseProvider = "pg" | "mysql" | "sqlite";

export interface GeneratorOptions {
	/** All prefixed tables collected from mounted services */
	tables: Map<string, PrefixedTable>;
	/** Target database provider */
	provider: DatabaseProvider;
	/** Output file path override */
	file?: string;
}

export type SchemaGenerator = (
	opts: GeneratorOptions,
) => Promise<SchemaGeneratorResult>;
