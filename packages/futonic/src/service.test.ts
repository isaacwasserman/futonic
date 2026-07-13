import { expect, test } from "bun:test";
import { type } from "arktype";
import {
	type Logger,
	createFutonicServiceConstructor,
	defineService,
	generateServiceDrizzleSchema,
} from "./service";
import { createSqliteConnection, drizzleFor } from "./test-helpers";

const dbSchema = {
	tables: {
		tickets: {
			name: "tickets",
			columns: { id: { type: "string", primaryKey: true } },
		},
	},
} as const;

test("rejects a service id that is not all-lowercase", () => {
	expect(() =>
		createFutonicServiceConstructor(
			defineService({
				id: "Ticketing",
				dbSchema,
				configSchema: type({ token: "string" }),
				endpoints: () => ({}),
			}),
		),
	).toThrow(/lowercase letters/);
});

test("rejects a non-camelCase schema key", () => {
	expect(() =>
		createFutonicServiceConstructor(
			defineService({
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
		),
	).toThrow(/camelCase/);
});

test("rejects a non-snake_case table name", () => {
	expect(() =>
		createFutonicServiceConstructor(
			defineService({
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
		),
	).toThrow(/snake_case/);
});

test("throws when the provided config fails the config schema", () => {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "svc",
			dbSchema,
			configSchema: type({ token: "string" }),
			endpoints: () => ({}),
		}),
	);

	expect(() =>
		make({
			config: {} as any,
			database: { connection: createSqliteConnection(), provider: "sqlite" },
		}),
	).toThrow(/Invalid config/);
});

function buildService(logger?: Logger) {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "ticketing",
			dbSchema,
			configSchema: type({ token: "string" }),
			endpoints: (defineEndpoint) => ({
				createTicket: defineEndpoint(
					"/tickets",
					{ method: "POST", body: type({ title: "string" }) },
					async (ctx) => {
						ctx.context.serviceCtx.logger.info("made", ctx.body.title);
						return { id: ctx.body.title };
					},
				),
				listTickets: defineEndpoint(
					"/tickets",
					{ method: "GET" },
					async () => ({ tickets: [] }),
				),
				updateTicket: defineEndpoint(
					"/tickets/:id",
					{ method: "PATCH", body: type({ title: "string" }) },
					async (ctx) => ({ id: ctx.params.id }),
				),
			}),
			serviceMethods: (define) => ({
				whoami: define(async (_input: Record<string, never>, { config }) => ({
					token: config.token,
				})),
			}),
		}),
	);

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

	const res = await svc.createHandler({ basePath: "/" }).handle(
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
	const res = await svc
		.createHandler({ basePath: "/" })
		.handle(new Request("http://x/nope", { method: "GET" }));
	expect(res.status).toBe(404);
});

test("basePath is stripped from the request URL before routing", async () => {
	const svc = buildService();

	const unmounted = await svc.createHandler({ basePath: "/" }).handle(
		new Request("http://x/api/tickets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "yo" }),
		}),
	);
	expect(unmounted.status).toBe(404);

	const mounted = await svc.createHandler({ basePath: "/api" }).handle(
		new Request("http://x/api/tickets", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "yo" }),
		}),
	);
	expect(mounted.ok).toBe(true);
	expect(await mounted.json()).toEqual({ id: "yo" });
});

test("openapi is enabled at /reference by default and can be disabled", async () => {
	const svc = buildService();

	const enabled = await svc
		.createHandler({ basePath: "/" })
		.handle(new Request("http://x/reference", { method: "GET" }));
	expect(enabled.status).toBe(200);

	const disabled = await svc
		.createHandler({ basePath: "/", openApi: false })
		.handle(new Request("http://x/reference", { method: "GET" }));
	expect(disabled.status).toBe(404);
});

test("openapi document keeps every method of a shared path and all verbs", async () => {
	const svc = buildService();
	const res = await svc.createHandler({ basePath: "/" }).handle(
		new Request("http://x/reference", {
			method: "GET",
			headers: { accept: "application/json" },
		}),
	);
	const doc = (await res.json()) as {
		paths: Record<string, Record<string, unknown>>;
	};

	expect(res.headers.get("content-type")).toContain("application/json");
	expect(Object.keys(doc.paths["/tickets"]).sort()).toEqual(["get", "post"]);
	expect(doc.paths["/tickets/{id}"]).toHaveProperty("patch");
});

async function openApiDoc(
	svc: ReturnType<typeof buildService>,
	openApi?: Parameters<typeof svc.createHandler>[0]["openApi"],
) {
	const res = await svc.createHandler({ basePath: "/", openApi }).handle(
		new Request("http://x/reference", {
			method: "GET",
			headers: { accept: "application/json" },
		}),
	);
	return (await res.json()) as {
		security?: unknown;
		components: { securitySchemes?: unknown };
		paths: Record<string, Record<string, { security?: unknown }>>;
	};
}

test("asserts no authentication scheme by default", async () => {
	const doc = await openApiDoc(buildService());
	expect(doc.security).toBeUndefined();
	expect(doc.components.securitySchemes).toBeUndefined();
	expect(doc.paths["/tickets"].post.security).toBeUndefined();
});

test("emits author-supplied security schemes and requirement", async () => {
	const doc = await openApiDoc(buildService(), {
		securitySchemes: {
			sessionCookie: {
				type: "apiKey",
				in: "cookie",
				name: "better-auth.session_token",
			},
		},
		security: [{ sessionCookie: [] }],
	});
	expect(doc.components.securitySchemes).toEqual({
		sessionCookie: {
			type: "apiKey",
			in: "cookie",
			name: "better-auth.session_token",
		},
	});
	expect(doc.security).toEqual([{ sessionCookie: [] }]);
});

test("generates the prefixed drizzle schema from the definition and dialect", () => {
	const schema = generateServiceDrizzleSchema(
		{ id: "ticketing", dbSchema },
		"sqlite",
		drizzleFor("sqlite"),
	);
	expect(Object.keys(schema)).toContain("ticketingTickets");
});
