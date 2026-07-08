import { expect, test } from "bun:test";
import { type } from "arktype";
import { createEndpoint } from "better-call";
import { type Logger, createFutonicServiceConstructor } from "./service";
import { createSqliteConnection } from "./test-helpers";

const dbSchema = {
	tables: {
		tickets: {
			name: "tickets",
			columns: { id: { type: "string", primaryKey: true } },
		},
	},
} as const;

// --- validation -----------------------------------------------------------

test("rejects a service id that is not all-lowercase", () => {
	expect(() =>
		createFutonicServiceConstructor({
			id: "Ticketing",
			dbSchema,
			configSchema: type({ token: "string" }),
			endpoints: () => ({}),
		}),
	).toThrow(/lowercase letters/);
});

test("rejects a non-camelCase schema key", () => {
	expect(() =>
		createFutonicServiceConstructor({
			id: "svc",
			dbSchema: {
				tables: {
					Tickets: {
						name: "tickets",
						columns: { id: { type: "string", primaryKey: true } },
					},
				},
			},
			configSchema: type({ token: "string" }),
			endpoints: () => ({}),
		}),
	).toThrow(/camelCase/);
});

test("rejects a non-snake_case table name", () => {
	expect(() =>
		createFutonicServiceConstructor({
			id: "svc",
			dbSchema: {
				tables: {
					tickets: {
						name: "Tickets",
						columns: { id: { type: "string", primaryKey: true } },
					},
				},
			},
			configSchema: type({ token: "string" }),
			endpoints: () => ({}),
		}),
	).toThrow(/snake_case/);
});

test("throws when the provided config fails the config schema", () => {
	const make = createFutonicServiceConstructor({
		id: "svc",
		dbSchema,
		configSchema: type({ token: "string" }),
		endpoints: () => ({}),
	});

	expect(() =>
		make({
			config: {} as any,
			database: { connection: createSqliteConnection(), provider: "sqlite" },
		}),
	).toThrow(/Invalid config/);
});

// --- construction & surface ----------------------------------------------

function buildService(logger?: Logger) {
	const make = createFutonicServiceConstructor({
		id: "ticketing",
		dbSchema,
		configSchema: type({ token: "string" }),
		endpoints: (use) => ({
			createTicket: createEndpoint(
				"/tickets",
				{ method: "POST", body: type({ title: "string" }), use },
				async (ctx) => {
					ctx.context.serviceCtx.logger.info("made", ctx.body.title);
					return { id: ctx.body.title };
				},
			),
		}),
		serviceMethods: (define) => ({
			whoami: define(async (_input: Record<string, never>, { config }) => ({
				token: config.token,
			})),
		}),
	});

	return make({
		config: { token: "secret" },
		database: { connection: createSqliteConnection(), provider: "sqlite" },
		logger,
	});
}

test("endpoints are callable in-process and run with context", async () => {
	const logs: string[] = [];
	const logger: Logger = {
		info: (...args) => logs.push(args.join(" ")),
		warn: () => {},
		error: () => {},
		debug: () => {},
	};
	const svc = buildService(logger);

	const result = await svc.endpoints.createTicket({ body: { title: "hi" } });
	expect(result).toEqual({ id: "hi" });
	expect(logs).toContain("made hi");
});

test("service methods are bound to the config context", async () => {
	const svc = buildService();
	expect(await svc.serviceMethods.whoami({})).toEqual({ token: "secret" });
});

test("the http handler dispatches requests to endpoints", async () => {
	const svc = buildService();

	const res = await svc.handler(
		new Request("http://x/tickets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "yo" }),
		}),
	);

	expect(res.ok).toBe(true);
	expect(await res.json()).toEqual({ id: "yo" });
});

test("the http handler 404s unknown routes", async () => {
	const svc = buildService();
	const res = await svc.handler(
		new Request("http://x/nope", { method: "GET" }),
	);
	expect(res.status).toBe(404);
});

test("exposes the prefixed drizzle schema", () => {
	const svc = buildService();
	expect(Object.keys(svc.drizzleSchema)).toContain("ticketingTickets");
});
