import { type } from "arktype";
import { createClient } from "better-call/client";
import Database from "better-sqlite3";
import * as sqliteCore from "drizzle-orm/sqlite-core";
import type { DrizzleBuilders, DrizzleDialect } from "./drizzle";
import {
	createFutonicServiceConstructor,
	defineService,
	generateServiceDrizzleSchema,
} from "./service";

/* IN SERVICE CODEBASE */

const ticketingDefinition = defineService({
	id: "ticketing",
	dbSchema: {
		tables: {
			tickets: {
				name: "tickets",
				columns: {
					id: { type: "string", primaryKey: true },
					title: { type: "string" },
					summary: { type: "string" },
					details: { type: "string", optional: true },
					status: { type: "enum", enumValues: ["open", "closed"] },
				},
			},
		},
	},
	configSchema: type({
		configVarA: "string",
	}),
	// Declaring `storage` surfaces a typed `ctx.storage`; `constraints` narrows
	// the framework's upload defaults for this service.
	storage: { constraints: { maxSizeBytes: 5 * 1024 * 1024 } },
	endpoints: (defineEndpoint) => ({
		createTicket: defineEndpoint(
			"/tickets",
			{
				method: "POST",
				body: type({
					title: "string",
					summary: "string",
					"details?": "string",
				}),
			},
			async (ctx) => {
				// `db`, `config`, and `logger` are injected by the service middleware.
				const { db, config, logger } = ctx.context.serviceCtx;
				void db;
				void config;
				logger.info("creating ticket", ctx.body.title);
				// `ctx.body` is inferred from the arktype schema.
				return { id: ctx.body.title };
			},
		),
		attachmentUploadUrl: defineEndpoint(
			"/tickets/attachment-url",
			{ method: "POST", body: type({ contentType: "string" }) },
			async (ctx) => {
				const { storage } = ctx.context.serviceCtx;
				const result = await storage.generatePresignedUploadUrl({
					key: "attachment",
					contentType: ctx.body.contentType,
				});
				return result;
			},
		),
	}),
	// Non-HTTP methods, resolved to context-free functions on the service.
	serviceMethods: (define) => ({
		closeStaleTickets: define(
			async (input: { olderThanDays: number }, { db, logger }) => {
				void db;
				logger.debug("closing stale tickets", input.olderThanDays);
				return { closed: 0 };
			},
		),
	}),
});

const createTicketingService =
	createFutonicServiceConstructor(ticketingDefinition);

// A service that does NOT declare storage must not expose `ctx.storage`.
const plainDefinition = defineService({
	id: "plain",
	dbSchema: { tables: {} },
	configSchema: type({}),
	endpoints: (defineEndpoint) => ({
		ping: defineEndpoint("/ping", { method: "GET" }, async (ctx) => {
			// @ts-expect-error storage is absent on services that don't declare it.
			void ctx.context.serviceCtx.storage;
			return { ok: true };
		}),
	}),
});
void plainDefinition;

// Wrap the generator so hosts build the tables by passing their own drizzle
// dialect module — the tables come back as the host's drizzle-orm types.
const ticketingDrizzleSchema = (
	dialect: DrizzleDialect,
	drizzle: DrizzleBuilders,
) => generateServiceDrizzleSchema(ticketingDefinition, dialect, drizzle);

/* IN HOST CODEBASE */

const ticketingService = createTicketingService({
	config: { configVarA: "something" },
	database: { connection: new Database(":memory:"), provider: "sqlite" },
	// No `provider` given, so futonic backs storage with the DB-backed default;
	// `signingKey`/`baseUrl` enable its presigned transfer route.
	storage: {
		signingKey: "dev-signing-key",
		baseUrl: "http://localhost/api/ticketing",
	},
});

// Drizzle tables for migrations, keyed and SQL-named by the service id.
const drizzleSchema = ticketingDrizzleSchema("sqlite", sqliteCore);

// HTTP entry point: createHandler({ basePath }).handle(request) => Promise<Response>
const handler = ticketingService.createHandler({ basePath: "/api/ticketing" });

// Typesafe client — typed from the service's router, called by method + path.
const client = createClient<typeof ticketingService.router>({
	baseURL: "http://localhost/api/ticketing",
});
const created = await client("@post/tickets", {
	body: { title: "Login broken", summary: "500 on submit" },
});

// Non-HTTP service method — context-free, strongly typed.
const closed = await ticketingService.serviceMethods.closeStaleTickets({
	olderThanDays: 30,
});

void handler;
void created;
void closed;
void drizzleSchema;
