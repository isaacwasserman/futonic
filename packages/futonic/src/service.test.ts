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
					{ method: "GET", query: type({ "q?": "string" }) },
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

test("a call-time endpoints override re-types the returned endpoints", async () => {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "typed",
			dbSchema,
			configSchema: type({ token: "string" }),
			endpoints: (defineEndpoint) => ({
				getThing: defineEndpoint("/thing", { method: "GET" }, async () => ({
					payload: {} as Record<string, unknown>,
				})),
			}),
		}),
	);
	const database = {
		connection: createSqliteConnection(),
		provider: "sqlite" as const,
	};

	const plain = make({ config: { token: "t" }, database });
	type PlainEndpoints = typeof plain.endpoints;

	type OverrideEndpoints = {
		getThing: PlainEndpoints["getThing"] & { __override: "meta" };
	};
	const overridden = make<OverrideEndpoints>({
		config: { token: "t" },
		database,
	});

	type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
		? 1
		: 2
		? true
		: false;
	type Expect<T extends true> = T;
	type _default = Expect<Equal<typeof plain.endpoints, PlainEndpoints>>;
	type _overridden = Expect<
		Equal<typeof overridden.endpoints, OverrideEndpoints>
	>;

	expect(await overridden.endpoints.getThing()).toEqual({ payload: {} });
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

test("derives request-body, query, and success schemas from validators", async () => {
	const svc = buildService();
	const res = await svc.createHandler({ basePath: "/" }).handle(
		new Request("http://x/reference", {
			method: "GET",
			headers: { accept: "application/json" },
		}),
	);
	const doc = (await res.json()) as {
		paths: Record<string, Record<string, any>>;
	};

	const post = doc.paths["/tickets"].post;
	expect(
		post.requestBody.content["application/json"].schema.properties,
	).toHaveProperty("title");
	expect(post.responses).toHaveProperty("200");

	const get = doc.paths["/tickets"].get;
	expect(get.parameters).toContainEqual(
		expect.objectContaining({ name: "q", in: "query" }),
	);
});

test("an output schema is emitted as the 200 response schema", async () => {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "things",
			dbSchema,
			configSchema: type({}),
			endpoints: (defineEndpoint) => ({
				getThing: defineEndpoint(
					"/things",
					{ method: "GET", output: type({ id: "string", count: "number" }) },
					async () => ({ id: "t1", count: 1 }),
				),
			}),
		}),
	);
	const svc = make({
		config: {},
		database: { connection: createSqliteConnection(), provider: "sqlite" },
	});
	const res = await svc.createHandler({ basePath: "/" }).handle(
		new Request("http://x/reference", {
			method: "GET",
			headers: { accept: "application/json" },
		}),
	);
	const doc = (await res.json()) as {
		paths: Record<string, Record<string, any>>;
	};
	const schema =
		doc.paths["/things"].get.responses["200"].content["application/json"]
			.schema;
	expect(schema.properties).toHaveProperty("id");
	expect(schema.properties).toHaveProperty("count");
});

// Type-level assertions (never executed) — the output schema must constrain the
// handler's return type at compile time.
async function _outputTypeChecks() {
	createFutonicServiceConstructor(
		defineService({
			id: "typecheck",
			dbSchema,
			configSchema: type({}),
			endpoints: (defineEndpoint) => ({
				good: defineEndpoint(
					"/good",
					{ method: "GET", output: type({ id: "string" }) },
					async () => ({ id: "ok" }),
				),
				bad: defineEndpoint(
					"/bad",
					{ method: "GET", output: type({ id: "string" }) },
					// @ts-expect-error handler return must match the output schema
					async () => ({ id: 123 }),
				),
			}),
		}),
	);
}
void _outputTypeChecks;

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

test("storage is injected and defaults to the DB-backed store when declared", async () => {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "docs",
			dbSchema,
			configSchema: type({}),
			storage: {},
			endpoints: (defineEndpoint) => ({
				save: defineEndpoint(
					"/save",
					{ method: "POST", body: type({ text: "string" }) },
					async (ctx) => {
						const result = await ctx.context.serviceCtx.storage.put({
							key: "note",
							body: new TextEncoder().encode(ctx.body.text),
						});
						return { error: result.error };
					},
				),
				uploadUrl: defineEndpoint(
					"/upload-url",
					{ method: "POST" },
					async (ctx) => {
						const result =
							await ctx.context.serviceCtx.storage.generatePresignedUploadUrl({
								key: "note",
							});
						return { error: result.error };
					},
				),
			}),
			serviceMethods: (define) => ({
				read: define(async (_input: Record<string, never>, { storage }) => {
					const result = await storage.get({ key: "note" });
					return {
						text: result.data
							? await new Response(result.data.body).text()
							: null,
					};
				}),
			}),
		}),
	);

	const svc = make({
		config: {},
		database: { connection: createSqliteConnection(), provider: "sqlite" },
	});

	expect(await svc.endpoints.save({ body: { text: "hello" } })).toEqual({
		error: null,
	});
	expect(await svc.serviceMethods.read({})).toEqual({ text: "hello" });
	// Presign is unavailable on the default store without a signing key.
	expect(await svc.endpoints.uploadUrl()).toEqual({ error: "UNSUPPORTED" });
});

test("presigned upload/download round-trips through the mounted transfer route", async () => {
	const make = createFutonicServiceConstructor(
		defineService({
			id: "docs",
			dbSchema,
			configSchema: type({}),
			storage: {},
			endpoints: (defineEndpoint) => ({
				uploadUrl: defineEndpoint("/upload-url", { method: "POST" }, (ctx) =>
					ctx.context.serviceCtx.storage.generatePresignedUploadUrl({
						key: "pic",
						contentType: "image/png",
					}),
				),
				downloadUrl: defineEndpoint(
					"/download-url",
					{ method: "POST" },
					(ctx) =>
						ctx.context.serviceCtx.storage.generatePresignedDownloadUrl({
							key: "pic",
						}),
				),
			}),
		}),
	);

	const svc = make({
		config: {},
		database: { connection: createSqliteConnection(), provider: "sqlite" },
		storage: { signingKey: "k", baseUrl: "http://x/api" },
	});
	const handler = svc.createHandler({ basePath: "/api" });

	const upload = await svc.endpoints.uploadUrl();
	if (upload.error) throw new Error(upload.error);
	// image/png forces better-call's router to read the body; the transfer route
	// must not depend on re-reading an already-consumed request.
	const put = await handler.handle(
		new Request(upload.data.url, {
			method: "PUT",
			headers: { "content-type": "image/png" },
			body: new Uint8Array([1, 2, 3, 4]),
		}),
	);
	expect(put.status).toBe(204);

	const download = await svc.endpoints.downloadUrl();
	if (download.error) throw new Error(download.error);
	const get = await handler.handle(new Request(download.data.url));
	expect(get.status).toBe(200);
	expect(new Uint8Array(await get.arrayBuffer())).toEqual(
		new Uint8Array([1, 2, 3, 4]),
	);
});
