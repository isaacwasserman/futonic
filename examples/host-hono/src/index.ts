/**
 * host-hono — example futonic host application.
 *
 * Run with: bun run start
 * Dev mode: bun run dev
 */

import { createApp } from "./app";

const { app, svc, close } = await createApp("host.db");

const port = Number(process.env.PORT) || 3000;

console.log(`\n  host-hono listening on http://localhost:${port}`);
console.log(`  Mounted service: ${svc.id}\n`);

const server = Bun.serve({
	port,
	fetch: app.fetch,
});

process.on("SIGINT", async () => {
	console.log("\nShutting down...");
	await close();
	server.stop();
	process.exit(0);
});
