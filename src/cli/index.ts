#!/usr/bin/env node

/**
 * CLI entry point for futonic.
 *
 * Commands:
 *   generate --orm=drizzle|prisma|kysely   Generate schema files for the host's ORM
 */

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
  futonic generate --orm=<drizzle|prisma|kysely>  Generate schema files

Options:
  --orm    Target ORM for schema generation (required)
  --out    Output path (optional, defaults vary by ORM)
`);
}

async function runGenerate(args: string[]) {
	const ormFlag = args.find((a) => a.startsWith("--orm="));
	if (!ormFlag) {
		console.error("Error: --orm flag is required");
		console.error("  futonic generate --orm=drizzle|prisma|kysely");
		process.exit(1);
	}

	const orm = ormFlag.split("=")[1];
	const outFlag = args.find((a) => a.startsWith("--out="));
	const outPath = outFlag?.split("=")[1];

	switch (orm) {
		case "drizzle": {
			const { generateDrizzleSchema } = await import("./generators/drizzle");
			await generateDrizzleSchema(outPath);
			break;
		}
		case "prisma": {
			const { generatePrismaSchema } = await import("./generators/prisma");
			await generatePrismaSchema(outPath);
			break;
		}
		case "kysely": {
			const { generateKyselySchema } = await import("./generators/kysely");
			await generateKyselySchema(outPath);
			break;
		}
		default:
			console.error(`Unknown ORM: ${orm}. Supported: drizzle, prisma, kysely`);
			process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
