#!/usr/bin/env node

/**
 * CLI entry point for futonic.
 *
 * Commands:
 *   generate --orm=drizzle|prisma|kysely --provider=pg|mysql|sqlite
 *
 * The CLI loads the host config, collects service tables, and delegates
 * to the appropriate ORM generator — following the same pattern as
 * better-auth's CLI.
 */

import type { DatabaseProvider, SchemaGenerator } from "./generators/types";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
	switch (command) {
		case "generate":
			await runGenerate(args.slice(1));
			break;
		default:
			printUsage();
			process.exit(1);
	}
}

function printUsage() {
	console.log(`
futonic CLI

Usage:
  futonic generate --orm=<drizzle|prisma|kysely> --provider=<pg|mysql|sqlite>

Options:
  --orm        Target ORM for schema generation (required)
  --provider   Database provider: pg, mysql, sqlite (default: pg)
  --out        Output path (optional, defaults vary by ORM)
  --config     Path to futonic config file (optional)
`);
}

function parseFlag(flags: string[], name: string): string | undefined {
	const flag = flags.find((a) => a.startsWith(`--${name}=`));
	return flag?.split("=")[1];
}

async function runGenerate(flags: string[]) {
	const orm = parseFlag(flags, "orm");
	if (!orm) {
		console.error("Error: --orm flag is required");
		console.error("  futonic generate --orm=drizzle|prisma|kysely");
		process.exit(1);
	}

	const provider = (parseFlag(flags, "provider") ?? "pg") as DatabaseProvider;
	if (!["pg", "mysql", "sqlite"].includes(provider)) {
		console.error(`Invalid provider: ${provider}. Must be pg, mysql, or sqlite`);
		process.exit(1);
	}

	const outPath = parseFlag(flags, "out");

	// Load host config and collect service tables
	// TODO: implement config file loading (reads host's futonic config,
	// instantiates services, calls getServiceTables)
	// For now, we demonstrate the generator pipeline with an empty table set
	const { getServiceTables } = await import("../db/schema");
	const tables = getServiceTables([]); // placeholder

	let generator: SchemaGenerator;
	switch (orm) {
		case "drizzle": {
			const { generateDrizzleSchema } = await import("./generators/drizzle");
			generator = generateDrizzleSchema;
			break;
		}
		case "prisma": {
			const { generatePrismaSchema } = await import("./generators/prisma");
			generator = generatePrismaSchema;
			break;
		}
		case "kysely": {
			const { generateKyselySchema } = await import("./generators/kysely");
			generator = generateKyselySchema;
			break;
		}
		default:
			console.error(`Unknown ORM: ${orm}. Supported: drizzle, prisma, kysely`);
			process.exit(1);
	}

	const result = await generator({ tables, provider, file: outPath });

	if (!result.code) {
		console.log("[futonic] No schema changes detected.");
		return;
	}

	// Write the generated file
	const { writeFile, mkdir } = await import("node:fs/promises");
	const path = await import("node:path");

	const dir = path.dirname(result.fileName);
	await mkdir(dir, { recursive: true });
	await writeFile(result.fileName, result.code, "utf-8");

	console.log(`[futonic] Generated ${orm} schema → ${result.fileName}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
