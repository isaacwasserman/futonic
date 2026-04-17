import { $ } from "bun";

console.log("[futonic-pgboss-dashboard] Building...");

await $`rm -rf dist`;
await Bun.build({
	entrypoints: ["src/index.ts"],
	outdir: "dist",
	target: "node",
	format: "esm",
	splitting: true,
	external: ["futonic", "@pg-boss/dashboard"],
});

await $`bunx tsc --emitDeclarationOnly`;

console.log("[futonic-pgboss-dashboard] Build complete.");
