import { $ } from "bun";

console.log("[futonic] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: ["src/index.ts", "src/client/index.ts", "src/db/drizzle.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external: [
		"better-call",
		"kysely",
		"drizzle-orm",
		"drizzle-orm/pg-core",
		"drizzle-orm/mysql-core",
		"drizzle-orm/sqlite-core",
		"pg",
		"mysql2",
		"better-sqlite3",
	],
});

// Generate declarations
await $`bunx tsc --emitDeclarationOnly`;

// Copy root README into package for npm
await $`cp ../../README.md ./README.md`;

console.log("[futonic] Build complete.");
