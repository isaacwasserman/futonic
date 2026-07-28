import { $ } from "bun";

console.log("[futonic] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: [
		"src/index.ts",
		"src/client.ts",
		"src/drizzle.ts",
		"src/storage/s3.ts",
	],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external: [
		"@aws-sdk/client-s3",
		"@aws-sdk/lib-storage",
		"@aws-sdk/s3-presigned-post",
		"@aws-sdk/s3-request-presigner",
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

await $`bunx tsc -p tsconfig.build.json --emitDeclarationOnly`;

console.log("[futonic] Build complete.");
