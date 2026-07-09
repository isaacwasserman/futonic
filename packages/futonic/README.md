# futonic

Build **embeddable services** — a vertical slice of API endpoints, validation, business logic, and database tables — that run in-process inside a host application instead of as a separate deployment.

There are two roles. A **service developer** builds a service as its own package (e.g. `@acme/ticketing`) and publishes it. A **host developer** installs that package and runs the service inside their app. The sections below follow that split.

---

# For service developers

```sh
bun add futonic
```

## 1. Define the service

`defineService` captures a service definition; `createFutonicServiceConstructor` turns it into a **constructor** that a host later calls with config and a database connection.

```ts
// @acme/ticketing/src/service.ts
import { type } from "arktype";
import { createFutonicServiceConstructor, defineService } from "futonic";

export const ticketingDefinition = defineService({
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

export const createTicketingService =
  createFutonicServiceConstructor(ticketingDefinition);
```

The Drizzle schema depends only on the definition and dialect — not on runtime config or a connection — so derive it with `generateServiceDrizzleSchema` and export a wrapper that bakes in the definition, leaving hosts to pass just the dialect:

```ts
// @acme/ticketing/src/service.ts (continued)
import { type DrizzleDialect, generateServiceDrizzleSchema } from "futonic";

export const ticketingDrizzleSchema = (dialect: DrizzleDialect) =>
  generateServiceDrizzleSchema(ticketingDefinition, dialect);
```

## 2. Export the package

Export the constructor and the schema wrapper. Consumers type their client from the service's `router`, so also export a type alias for it:

```ts
// @acme/ticketing/src/index.ts
export { createTicketingService, ticketingDrizzleSchema } from "./service";
export type TicketingRouter = ReturnType<
  typeof import("./service").createTicketingService
>["router"];
```

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

A constructed service exposes: `handler`, `endpoints`, `router`, and `serviceMethods`.

## 2. Migrate

`ticketingDrizzleSchema(dialect)` returns a Drizzle table set (keyed and SQL-named by the service id). Re-export its tables from the schema file your drizzle-kit config points at, and migrations run against the host database alongside your own tables:

```ts
// schema.ts
import { ticketingDrizzleSchema } from "@acme/ticketing";

export const { ticketingTickets } = ticketingDrizzleSchema("sqlite");
```

## 3. Call it from a client

`futonic/client` re-exports better-call's typesafe `createClient`. Type it from the service router (a type-only import, so no server code is bundled) and call endpoints by method + path — `GET` is the bare path, others are prefixed `@method`:

```ts
import { createClient } from "futonic/client";
import type { TicketingRouter } from "@acme/ticketing"; // type-only

const client = createClient<TicketingRouter>({ baseURL: "/api/ticketing" });
const res = await client("@post/tickets", { body: { title: "x", summary: "y" } });
res.data; // { id: string } — inferred from the router
```

---

## Entry points

| Import | Exports you'll use | Browser-safe |
| --- | --- | --- |
| `futonic` | `createFutonicServiceConstructor`, `defineService`, `generateServiceDrizzleSchema`, and db-schema types | No |
| `futonic/client` | `createClient`, `ClientOptions` | Yes |
| `futonic/drizzle` | `generateDrizzleSchema`, `DrizzleDialect`, and Drizzle types | No |
