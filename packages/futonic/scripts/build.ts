import { $ } from "bun";

console.log("[futonic] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: [
		"src/index.ts",
		"src/client/index.ts",
		"src/cli/index.ts",
	],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external: [
		"better-call",
		"kysely",
		"pg",
		"mysql2",
		"better-sqlite3",
		"@mrleebo/prisma-ast",
	],
});

// Generate declarations
await $`bunx tsc --emitDeclarationOnly`;

// Copy root README into package for npm
await $`cp ../../README.md ./README.md`;

console.log("[futonic] Build complete.");
