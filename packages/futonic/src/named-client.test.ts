import { expect, test } from "bun:test";
import { type } from "arktype";
import { createNamedClient, toNamedClientRoutes } from "./named-client";
import { createFutonicServiceConstructor } from "./service";
import { createSqliteConnection } from "./test-helpers";

function buildService() {
	const make = createFutonicServiceConstructor({
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
				items: ["a", "b"],
			})),
		}),
	});

	return make({
		config: { token: "x" },
		database: { connection: createSqliteConnection(), provider: "sqlite" },
	});
}

// Route the client's fetch straight into the service handler so the whole
// name → path → handler round trip is exercised without a real network.
function namedClientFor(svc: ReturnType<typeof buildService>) {
	return createNamedClient(toNamedClientRoutes(svc.endpoints), {
		baseURL: "http://localhost",
		customFetchImpl: (input, init) =>
			svc.handler(
				new Request(input as string | URL, init as RequestInit | undefined),
			),
	});
}

test("calls a POST endpoint by name with a typed body", async () => {
	const svc = buildService();
	const client = namedClientFor(svc);

	const res = await client.createTicket({ body: { title: "hi" } });
	expect(res.data).toEqual({ id: "hi" });
});

test("calls a GET endpoint by name with no arguments", async () => {
	const svc = buildService();
	const client = namedClientFor(svc);

	const res = await client.listTickets();
	expect(res.data).toEqual({ items: ["a", "b"] });
});

test("routes same-path endpoints by method (POST vs GET on /tickets)", async () => {
	const svc = buildService();
	const client = namedClientFor(svc);

	const created = await client.createTicket({ body: { title: "z" } });
	const listed = await client.listTickets();

	expect(created.data).toEqual({ id: "z" });
	expect(listed.data).toEqual({ items: ["a", "b"] });
});
