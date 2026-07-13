/**
 * Boots a throwaway futonic service and serves its OpenAPI reference so you can
 * open it in a browser. Run: `bun run scripts/openapi-preview.ts` then visit the
 * printed URL. Endpoints mirror a real service (multiple methods per path, path
 * params, PATCH/DELETE) so you can confirm none are dropped.
 */

import { type } from "arktype";
import {
	createFutonicServiceConstructor,
	defineService,
} from "../src/service";
import { createSqliteConnection } from "../src/test-helpers";

const make = createFutonicServiceConstructor(
	defineService({
		id: "ticketing",
		dbSchema: {
			tables: {
				tickets: {
					name: "tickets",
					columns: { id: { type: "string", primaryKey: true } },
				},
			},
		},
		configSchema: type({}),
		endpoints: (defineEndpoint) => ({
			// POST is registered before GET on purpose — the case better-call dropped.
			createTicket: defineEndpoint(
				"/tickets",
				{ method: "POST", body: type({ subject: "string", description: "string" }) },
				async () => ({ id: "t_1" }),
			),
			listTickets: defineEndpoint("/tickets", { method: "GET" }, async () => ({
				tickets: [],
			})),
			getTicket: defineEndpoint(
				"/tickets/:id",
				{ method: "GET" },
				async (ctx) => ({ id: ctx.params.id }),
			),
			updateTicket: defineEndpoint(
				"/tickets/:id",
				{ method: "PATCH", body: type({ "status?": "string" }) },
				async (ctx) => ({ id: ctx.params.id }),
			),
			deleteTicket: defineEndpoint(
				"/tickets/:id",
				{ method: "DELETE" },
				async () => ({ ok: true }),
			),
			setUserRole: defineEndpoint(
				"/users/:id/role",
				{ method: "PATCH", body: type({ role: "'user' | 'agent'" }) },
				async (ctx) => ({ id: ctx.params.id }),
			),
		}),
	}),
);

const svc = make({
	config: {},
	database: { connection: createSqliteConnection(), provider: "sqlite" },
});
const handler = svc.createHandler({
	basePath: "/",
	openApi: {
		info: { title: "Ticketing", description: "Preview" },
		securitySchemes: {
			sessionCookie: {
				type: "apiKey",
				in: "cookie",
				name: "better-auth.session_token",
			},
		},
		security: [{ sessionCookie: [] }],
	},
});

const server = Bun.serve({
	port: 4000,
	fetch: (req) => handler.handle(req),
});

console.log(`\n  Reference UI:  ${server.url}reference`);
console.log(`  Raw document:  curl -H 'accept: application/json' ${server.url}reference\n`);
