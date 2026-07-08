import { $ } from "bun";

console.log("[futonic] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: ["src/index.ts", "src/client.ts", "src/drizzle.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external: [
		"better-call",
		"better-call/client",
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

// Generate declarations (build config excludes tests + test helpers)
await $`bunx tsc -p tsconfig.build.json --emitDeclarationOnly`;

// Copy root README into package for npm
await $`cp ../../README.md ./README.md`;

console.log("[futonic] Build complete.");
