import { type } from "arktype";
import { createClient } from "better-call/client";
import Database from "better-sqlite3";
import { createFutonicServiceConstructor } from "./service";

/* IN SERVICE CODEBASE */

const createTicketingService = createFutonicServiceConstructor({
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

/* IN HOST CODEBASE */

const ticketingService = createTicketingService({
	config: { configVarA: "something" },
	database: { connection: new Database(":memory:"), provider: "sqlite" },
});

// HTTP entry point: (request: Request) => Promise<Response>
const handler = ticketingService.handler;

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
