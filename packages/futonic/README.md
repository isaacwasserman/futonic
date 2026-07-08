# futonic

Build **embeddable services** — a vertical slice of API endpoints, validation, business logic, and database tables — that run in-process inside a host application instead of as a separate deployment.

There are two roles. A **service developer** builds a service as its own package (e.g. `@acme/ticketing`) and publishes it. A **host developer** installs that package and runs the service inside their app. The sections below follow that split.

---

# For service developers

```sh
bun add futonic
```

## 1. Define the service

`createFutonicServiceConstructor` returns a **constructor** that a host later calls with config and a database connection.

```ts
// @acme/ticketing/src/service.ts
import { type } from "arktype";
import { createFutonicServiceConstructor } from "futonic";

export const createTicketingService = createFutonicServiceConstructor({
  // Lowercase-letters-only id. Used to prefix table names (`ticketing_tickets`).
  id: "ticketing",

  // Tables. Keys are camelCase; `name` is the snake_case physical table.
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

  // Host-supplied config, validated once at construction (any Standard Schema).
  configSchema: type({ apiKey: "string" }),

  // HTTP endpoints. `defineEndpoint` already carries the service middleware,
  // so handlers read `ctx.context.serviceCtx` — typed `{ db, config, logger }`.
  endpoints: (defineEndpoint) => ({
    createTicket: defineEndpoint(
      "/tickets",
      { method: "POST", body: type({ title: "string", summary: "string" }) },
      async (ctx) => {
        const { db, config, logger } = ctx.context.serviceCtx;
        logger.info("creating ticket", ctx.body.title);
        // `db` is a Kysely instance typed from `dbSchema`; `ctx.body` is
        // inferred from the arktype schema above.
        await db
          .insertInto("tickets")
          .values({ id: ctx.body.title, ...ctx.body, status: "open" })
          .execute();
        return { id: ctx.body.title };
      },
    ),
    listTickets: defineEndpoint("/tickets", { method: "GET" }, async (ctx) => {
      const { db } = ctx.context.serviceCtx;
      return { items: await db.selectFrom("tickets").selectAll().execute() };
    }),
  }),

  // Optional non-HTTP methods. Context-free at the call site; each receives
  // `{ db, config, logger }` as its second argument.
  serviceMethods: (define) => ({
    closeStaleTickets: define(
      async (input: { olderThanDays: number }, { db, logger }) => {
        logger.debug("closing stale tickets", input.olderThanDays);
        return { closed: 0 };
      },
    ),
  }),
});
```

## 2. Generate the client

Run codegen to turn the live endpoints into a static, serializable route manifest (plain data plus a type-only import). Add this build script and re-run it whenever endpoints change:

```ts
// @acme/ticketing/scripts/gen-client.ts
import { writeFileSync } from "node:fs";
import { generateNamedClientModule } from "futonic";
import { createTicketingService } from "../src/service";

const source = generateNamedClientModule(createTicketingService.definition, {
  exportName: "ticketingRoutes",
  // A type expression for the endpoints record; a type-only `import(...)`
  // keeps server code out of the bundle.
  endpointsType:
    'ReturnType<typeof import("../src/service").createTicketingService>["endpoints"]',
});
writeFileSync("src/client.generated.ts", source);
```

It emits (and you commit) the manifest module:

```ts
// @acme/ticketing/src/client.generated.ts
import type { NamedClientRoutes } from "futonic/client";

export const ticketingRoutes: NamedClientRoutes<
  ReturnType<typeof import("../src/service").createTicketingService>["endpoints"]
> = {
  createTicket: { method: "POST", path: "/tickets" },
  listTickets: { method: "GET", path: "/tickets" },
};
```

## 3. Export the package

Publish the constructor and a client factory. The factory imports only the manifest and `futonic/client`, so it pulls in **no server code** and is safe in a browser:

```ts
// @acme/ticketing/src/client.ts  →  exported as "@acme/ticketing/client"
import { createClientFromManifest, type ClientOptions } from "futonic/client";
import { ticketingRoutes } from "./client.generated";

export const createTicketingClient = (options?: ClientOptions) =>
  createClientFromManifest(ticketingRoutes, options);
```

Your package now exposes `createTicketingService` (server) and `createTicketingClient` (client).

---

# For host developers

```sh
bun add @acme/ticketing better-sqlite3
```

Install the service package plus the driver for your database (`better-sqlite3`, `pg`, or `mysql2`); add `drizzle-orm` if you run migrations.

## 1. Instantiate and mount

Construct the service with your config and the shared database connection, then mount its HTTP handler on any route that speaks `Request`/`Response`.

```ts
import Database from "better-sqlite3";
import { createTicketingService } from "@acme/ticketing";

const ticketing = createTicketingService({
  config: { apiKey: process.env.TICKETING_KEY! },
  database: { connection: new Database("app.db"), provider: "sqlite" },
  // logger?: defaults to `console`, prefixed with the service id.
});

// HTTP entry point: (request: Request) => Promise<Response>
export const handler = ticketing.handler;

// Non-HTTP methods — context-free and strongly typed.
await ticketing.serviceMethods.closeStaleTickets({ olderThanDays: 30 });
```

A constructed service exposes: `handler`, `endpoints`, `router`, `serviceMethods`, and `drizzleSchema`.

## 2. Migrate

`ticketing.drizzleSchema` is a Drizzle table set (keyed and SQL-named by the service id). Re-export its tables from the schema file your drizzle-kit config points at, and migrations run against the host database alongside your own tables:

```ts
// schema.ts
export const { tickets } = ticketing.drizzleSchema;
```

## 3. Call it from a client

Use the factory the service package exports — from your backend, another service, or the browser. Calls are typed end to end with no manual type argument:

```ts
import { createTicketingClient } from "@acme/ticketing/client";

const client = createTicketingClient({ baseURL: "/api/ticketing" });
const res = await client.createTicket({ body: { title: "x", summary: "y" } });
res.data; // { id: string } — inferred from the manifest brand
```

---

## Entry points

| Import | Exports you'll use | Browser-safe |
| --- | --- | --- |
| `futonic` | `createFutonicServiceConstructor`, `generateNamedClientModule` | No |
| `futonic/client` | `createClientFromManifest`, `NamedClientRoutes`, `ClientOptions` | Yes |
| `futonic/drizzle` | `generateDrizzleSchema` and Drizzle types | No |
