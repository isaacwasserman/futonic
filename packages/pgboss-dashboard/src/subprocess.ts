import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export interface SubprocessOptions {
	/** Postgres connection string. Supports `Name=url|Name2=url2` for multi-DB. */
	databaseURL: string;
	/** Schema name(s). Pipe-separated to match `databaseURL` entries. Default `pgboss`. */
	schema?: string;
	/** Optional HTTP basic auth for the dashboard. */
	auth?: { username: string; password: string };
	/** Port to bind the dashboard subprocess to. Defaults to a random free port. */
	port?: number;
	/** Host interface to bind to. Defaults to 127.0.0.1 for in-process embedding. */
	host?: string;
	/** Absolute path to the @pg-boss/dashboard CLI. Auto-resolved from host node_modules by default. */
	binPath?: string;
	/** Node executable. Defaults to process.execPath. */
	nodeBin?: string;
	/** Max milliseconds to wait for the subprocess to start listening. Default 15_000. */
	startupTimeoutMs?: number;
	/** Writable streams for the subprocess's stdout/stderr. Defaults to "inherit". */
	stdio?: "inherit" | "pipe" | "ignore";
	/** Optional logger for lifecycle events. */
	logger?: {
		info: (msg: string, ...args: unknown[]) => void;
		warn: (msg: string, ...args: unknown[]) => void;
		error: (msg: string, ...args: unknown[]) => void;
	};
}

export interface DashboardSubprocess {
	/** Port the subprocess is listening on. */
	readonly port: number;
	/** Host the subprocess is listening on. */
	readonly host: string;
	/** Upstream origin, e.g. http://127.0.0.1:38291 */
	readonly origin: string;
	/** Kill the subprocess and wait for it to exit. */
	stop(): Promise<void>;
}

/**
 * Resolves the absolute path to @pg-boss/dashboard's CLI by asking Node to
 * resolve the package's package.json relative to the host app. Falls back to
 * looking inside this package's own node_modules if the host hasn't installed
 * it directly (works with hoisted workspace installs).
 */
function resolveDashboardBin(): string {
	const require = createRequire(import.meta.url);
	const pkgJson = require.resolve("@pg-boss/dashboard/package.json");
	const pkgDir = pkgJson.replace(/[\\/]package\.json$/, "");
	return `${pkgDir}/bin/cli.js`;
}

/**
 * Asks the OS for a free TCP port by binding port 0 and reading back the
 * assigned port. Closes the listener before returning so the caller can reuse
 * the port immediately.
 */
export async function findFreePort(host = "127.0.0.1"): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen({ port: 0, host }, () => {
			const addr = server.address();
			if (typeof addr !== "object" || !addr) {
				server.close();
				reject(new Error("Failed to allocate a free port"));
				return;
			}
			const port = addr.port;
			server.close(() => resolve(port));
		});
	});
}

/**
 * Polls a TCP host:port until a connection succeeds or the deadline expires.
 * The dashboard is considered "ready" once its Hono server accepts a connection.
 */
async function waitForPort(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;

	while (Date.now() < deadline) {
		try {
			await new Promise<void>((resolve, reject) => {
				const { Socket } = require("node:net");
				const socket = new Socket();
				socket.setTimeout(1000);
				socket.once("error", reject);
				socket.once("timeout", () => {
					socket.destroy();
					reject(new Error("connect timeout"));
				});
				socket.connect(port, host, () => {
					socket.end();
					resolve();
				});
			});
			return;
		} catch (err) {
			lastError = err;
			await sleep(150);
		}
	}

	throw new Error(
		`@pg-boss/dashboard did not start listening on ${host}:${port} within ${timeoutMs}ms: ${String(lastError)}`,
	);
}

/**
 * Spawns `@pg-boss/dashboard` as a child process configured via env vars.
 * Resolves once the subprocess is accepting TCP connections on its port.
 *
 * The CLI script auto-starts the Hono server on import, so the subprocess
 * is the only supported way to run the upstream dashboard without forking it.
 */
export async function startDashboardSubprocess(
	options: SubprocessOptions,
): Promise<DashboardSubprocess> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? (await findFreePort(host));
	const binPath = options.binPath ?? resolveDashboardBin();
	const nodeBin = options.nodeBin ?? process.execPath;
	const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;

	const env: NodeJS.ProcessEnv = {
		...process.env,
		DATABASE_URL: options.databaseURL,
		PGBOSS_SCHEMA: options.schema ?? "pgboss",
		PORT: String(port),
		HOST: host,
	};

	if (options.auth) {
		env.PGBOSS_DASHBOARD_AUTH_USERNAME = options.auth.username;
		env.PGBOSS_DASHBOARD_AUTH_PASSWORD = options.auth.password;
	}

	options.logger?.info(
		`Starting @pg-boss/dashboard subprocess on ${host}:${port}`,
	);

	const child: ChildProcess = spawn(nodeBin, [binPath], {
		env,
		stdio: options.stdio ?? "inherit",
		detached: false,
	});

	let exited = false;
	let exitError: Error | undefined;
	const exitPromise = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			exited = true;
			if (code != null && code !== 0) {
				exitError = new Error(`@pg-boss/dashboard exited with code ${code}`);
			} else if (signal) {
				exitError = new Error(
					`@pg-boss/dashboard killed with signal ${signal}`,
				);
			}
			resolve();
		});
	});

	try {
		await Promise.race([
			waitForPort(host, port, startupTimeoutMs),
			exitPromise.then(() => {
				throw (
					exitError ??
					new Error("@pg-boss/dashboard exited before it started listening")
				);
			}),
		]);
	} catch (err) {
		if (!exited) child.kill("SIGTERM");
		throw err;
	}

	options.logger?.info(`@pg-boss/dashboard ready at http://${host}:${port}`);

	return {
		port,
		host,
		origin: `http://${host}:${port}`,
		async stop() {
			if (exited) return;
			child.kill("SIGTERM");
			const killed = await Promise.race([
				exitPromise.then(() => true),
				sleep(5_000).then(() => false),
			]);
			if (!killed && !exited) {
				child.kill("SIGKILL");
				await exitPromise;
			}
		},
	};
}
