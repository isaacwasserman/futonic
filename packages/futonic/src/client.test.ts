import { expect, test } from "bun:test";
import { type } from "arktype";
import { createClient } from "better-call/client";
import { createFutonicServiceConstructor, defineService } from "./service";
import { createSqliteConnection } from "./test-helpers";

function buildService() {
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
			configSchema: type({ token: "string" }),
			endpoints: (defineEndpoint) => ({
				createTicket: defineEndpoint(
					"/tickets",
					{ method: "POST", body: type({ title: "string" }) },
					async (ctx) => ({ id: ctx.body.title }),
				),
				listTickets: defineEndpoint(
					"/tickets",
					{ method: "GET" },
					async () => ({
						items: ["a", "b"],
					}),
				),
			}),
		}),
	);

	return make({
		config: { token: "x" },
		database: { connection: createSqliteConnection(), provider: "sqlite" },
	});
}

// Route the client's fetch straight into the service handler so the whole
// client → path → handler round trip is exercised without a real network.
function clientFor(svc: ReturnType<typeof buildService>) {
	return createClient<typeof svc.router>({
		baseURL: "http://localhost",
		customFetchImpl: (input, init) =>
			svc.handler(
				new Request(input as string | URL, init as RequestInit | undefined),
				{ basePath: "/" },
			),
	});
}

test("calls a POST endpoint by method + path with a typed body", async () => {
	const client = clientFor(buildService());

	const res = await client("@post/tickets", { body: { title: "hi" } });
	expect(res.data).toEqual({ id: "hi" });
});

test("calls a GET endpoint by its bare path", async () => {
	const client = clientFor(buildService());

	const res = await client("/tickets");
	expect(res.data).toEqual({ items: ["a", "b"] });
});
