/**
 * CLI factory for service authors.
 *
 * Service packages wrap this to provide their own CLI:
 *
 * ```ts
 * // packages/acme-billing/src/cli.ts
 * #!/usr/bin/env node
 * import { createCLI } from "futonic/cli";
 * import { billingService } from "./service";
 *
 * createCLI({ service: billingService });
 * ```
 *
 * The host developer then runs:
 *   npx acme-billing generate --orm=drizzle --provider=pg
 *
 * And gets migration files for just that service's tables.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EmbeddableService } from "../core/service";
import { getServiceTables } from "../db/schema";
import type { DatabaseProvider, SchemaGenerator } from "./generators/types";

export interface CLIOptions {
	/** The service definition (pre-mount, has dbSchema) */
	service: EmbeddableService;
	/** Optional name override for CLI output (defaults to service.id) */
	name?: string;
}

export function createCLI(options: CLIOptions): void {
	const args = process.argv.slice(2);
	const command = args[0];
	const serviceName = options.name ?? options.service.id;

	switch (command) {
		case "generate":
			runGenerate(args.slice(1), options).catch((err) => {
				console.error(err);
				process.exit(1);
			});
			break;
		default:
			printUsage(serviceName);
			process.exit(command ? 1 : 0);
	}
}

function printUsage(name: string) {
	console.log(`
${name} CLI (powered by futonic)

Usage:
  ${name} generate --orm=<drizzle|prisma|kysely> [options]

Commands:
  generate    Generate database schema files for the host application

Options:
  --orm        Target ORM (required): drizzle, prisma, kysely
  --provider   Database provider: pg, mysql, sqlite (default: pg)
  --out        Output file path (optional, defaults vary by ORM)
`);
}

function parseFlag(flags: string[], name: string): string | undefined {
	const flag = flags.find((a) => a.startsWith(`--${name}=`));
	return flag?.split("=")[1];
}

async function runGenerate(flags: string[], options: CLIOptions) {
	const { service } = options;
	const serviceName = options.name ?? service.id;

	const orm = parseFlag(flags, "orm");
	if (!orm) {
		console.error("Error: --orm flag is required");
		console.error(`  ${serviceName} generate --orm=drizzle|prisma|kysely`);
		process.exit(1);
	}

	const provider = (parseFlag(flags, "provider") ?? "pg") as DatabaseProvider;
	if (!["pg", "mysql", "sqlite"].includes(provider)) {
		console.error(
			`Invalid provider: ${provider}. Must be pg, mysql, or sqlite`,
		);
		process.exit(1);
	}

	const outPath = parseFlag(flags, "out");

	// Build the table map from this service's schema.
	// We create a minimal MountedService shape just for getServiceTables.
	const tables = getServiceTables([
		{
			...service,
			mountConfig: { mount: "" },
		},
	]);

	const generator = await loadGenerator(orm);

	const result = await generator({ tables, provider, file: outPath });

	if (!result.code) {
		console.log(`[${serviceName}] No schema changes detected.`);
		return;
	}

	const dir = path.dirname(result.fileName);
	await mkdir(dir, { recursive: true });
	await writeFile(result.fileName, result.code, "utf-8");

	console.log(`[${serviceName}] Generated ${orm} schema → ${result.fileName}`);
}

async function loadGenerator(orm: string): Promise<SchemaGenerator> {
	switch (orm) {
		case "drizzle": {
			const { generateDrizzleSchema } = await import("./generators/drizzle");
			return generateDrizzleSchema;
		}
		case "prisma": {
			const { generatePrismaSchema } = await import("./generators/prisma");
			return generatePrismaSchema;
		}
		case "kysely": {
			const { generateKyselySchema } = await import("./generators/kysely");
			return generateKyselySchema;
		}
		default:
			console.error(`Unknown ORM: ${orm}. Supported: drizzle, prisma, kysely`);
			process.exit(1);
	}
}
