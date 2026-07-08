import { expect, test } from "bun:test";
import { type } from "arktype";
import { extractClientRoutes, generateNamedClientModule } from "./codegen";
import { toNamedClientRoutes } from "./named-client";
import { createFutonicServiceConstructor } from "./service";
import { createSqliteConnection } from "./test-helpers";

function buildConstructor() {
	return createFutonicServiceConstructor({
		id: "ticketing",
		dbSchema: {
			tables: {
				tickets: {
					name: "tickets",
					columns: { id: { type: "string", primaryKey: true } },
				},
			},
		},
		configSchema: type({ token: "string" }),
		endpoints: (defineEndpoint) => ({
			createTicket: defineEndpoint(
				"/tickets",
				{ method: "POST", body: type({ title: "string" }) },
				async (ctx) => ({ id: ctx.body.title }),
			),
			listTickets: defineEndpoint("/tickets", { method: "GET" }, async () => ({
				items: [] as string[],
			})),
		}),
	});
}

test("extracts routes from the definition without constructing the service", () => {
	const make = buildConstructor();
	const routes = extractClientRoutes(make.definition);

	expect(routes).toEqual({
		createTicket: { method: "POST", path: "/tickets" },
		listTickets: { method: "GET", path: "/tickets" },
	});
});

test("extracted routes match the constructed service's endpoints", () => {
	const make = buildConstructor();
	const svc = make({
		config: { token: "x" },
		database: { connection: createSqliteConnection(), provider: "sqlite" },
	});

	expect(extractClientRoutes(make.definition)).toEqual(
		toNamedClientRoutes(svc.endpoints),
	);
});

test("generates a static, browser-safe manifest module", () => {
	const make = buildConstructor();
	const source = generateNamedClientModule(make.definition, {
		endpointsType:
			'ReturnType<typeof import("./service").createTicketingService>["endpoints"]',
		exportName: "ticketingRoutes",
	});

	expect(source).toBe(
		`import type { NamedClientRoutes } from "futonic/client";

export const ticketingRoutes: NamedClientRoutes<ReturnType<typeof import("./service").createTicketingService>["endpoints"]> = {
\t"createTicket": { method: "POST", path: "/tickets" },
\t"listTickets": { method: "GET", path: "/tickets" },
};
`,
	);
});
