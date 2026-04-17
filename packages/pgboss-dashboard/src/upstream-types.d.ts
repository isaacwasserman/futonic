/**
 * `@pg-boss/dashboard` ships only JavaScript — no declaration files — and the
 * sub-path `build/server/index.js` is not listed in its package.json exports.
 * We import it dynamically at runtime so we can intercept the stray TCP
 * listener; here we tell TypeScript what shape to expect.
 */
declare module "@pg-boss/dashboard/build/server/index.js" {
	import type { Hono } from "hono";
	const server: Promise<Hono> | Hono;
	export default server;
}
