# Futonic 🛋️

**A framework for building services that embed into a host application instead of deploying alongside it.**

A futonic service is a **vertical slice** — API endpoints, input validation, business logic, and database tables — published as an npm package and run *in-process* inside a host app. No extra container, no network hops, no separate database: the service shares the host's process and connection pool, and its tables live in the host's database under a service-id prefix.

This page is the usage reference. For the motivation and design behind embeddable services, see the [repository README](https://github.com/isaacwasserman/futonic).

## Install

```sh
bun add futonic
```

## Two roles

A **service developer** builds a service as its own package (e.g. `@acme/ticketing`) and publishes it. A **host developer** installs that package and runs the service inside their app. The sections below follow that split.

## For service developers

### 1. Define the service

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
      {
        method: "POST",
        body: type({ title: "string", summary: "string" }),
        // `output` (any Standard Schema) is compile-time-checked against the
        // handler's return type and emitted as the `200` response schema.
        output: type({ id: "string" }),
      },
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

### 2. Export the package

Export the constructor and the schema wrapper. Consumers type their client from the service's `router`, so also export a type alias for it:

```ts
// @acme/ticketing/src/index.ts
export { createTicketingService, ticketingDrizzleSchema } from "./service";
export type TicketingRouter = ReturnType<
  typeof import("./service").createTicketingService
>["router"];
```

## For host developers

```sh
bun add @acme/ticketing better-sqlite3
```

Install the service package plus the driver for your database (`better-sqlite3`, `pg`, or `mysql2`); add `drizzle-orm` if you run migrations.

### 1. Instantiate and mount

Construct the service with your config and the shared database connection, then mount its HTTP handler on any route that speaks `Request`/`Response`.

```ts
import Database from "better-sqlite3";
import { createTicketingService } from "@acme/ticketing";

const ticketing = createTicketingService({
  config: { apiKey: process.env.TICKETING_KEY! },
  database: { connection: new Database("app.db"), provider: "sqlite" },
  // logger?: defaults to `console`, prefixed with the service id.
});

// HTTP entry point: createHandler({ basePath }).handle(request) => Promise<Response>
// `basePath` is the mount path, stripped before routing (`/` when mounted at root).
const handler = ticketing.createHandler({ basePath: "/api/ticketing" });
export const route = (req: Request) => handler.handle(req);
```

A constructed service exposes `createHandler`, `endpoints`, `router`, and `serviceMethods`. An OpenAPI reference is served at `/reference` by default; pass `openApi` to override the document's `info`, `servers`, `path`, `theme`, or `securitySchemes`/`security`, or `openApi: false` to disable it.

### 2. Migrate

`ticketingDrizzleSchema(dialect)` returns a Drizzle table set (keyed and SQL-named by the service id). Re-export its tables from the schema file your drizzle-kit config points at, and migrations run against the host database alongside your own tables:

```ts
// schema.ts
import { ticketingDrizzleSchema } from "@acme/ticketing";

export const { ticketingTickets } = ticketingDrizzleSchema("sqlite");
```

Prefer another migration tool? A service only declares its tables in `dbSchema` — create the matching prefixed tables (`ticketing_tickets`) with whatever tooling you already use. Futonic doesn't impose one.

### 3. Call it from a client

`futonic/client` re-exports better-call's typesafe `createClient`. Type it from the service router (a type-only import, so no server code is bundled) and call endpoints by method + path — `GET` is the bare path, others are prefixed `@method`:

```ts
import { createClient } from "futonic/client";
import type { TicketingRouter } from "@acme/ticketing"; // type-only

const client = createClient<TicketingRouter>({ baseURL: "/api/ticketing" });
const res = await client("@post/tickets", { body: { title: "x", summary: "y" } });
res.data; // { id: string } — inferred from the router
```

## More features

### Let hosts pin open endpoint types

Some endpoints can't name a type up front — they accept or return an opaque payload (arbitrary metadata, a host-defined document body) whose shape only the host knows. The constructor takes an optional **endpoints-override** type argument for exactly this: `constructor<Override>(options)` re-types the returned `endpoints` — and therefore the typed client derived from them — to `Override`, defaulting to the types inferred from the definition so plain `constructor(options)` calls are unchanged.

The runtime endpoints are identical; the override is a compile-time view the caller vouches for — validation still runs the definition's real schemas. A service usually wraps it so hosts pass a domain type instead of a whole endpoints record:

```ts
// @acme/ticketing — the definition leaves an endpoint payload open; the wrapper
// lets a host pin its shape end-to-end. `TicketingEndpoints<Meta>` is a type the
// service author derives from its own generic endpoints factory.
export function createTicketing<
  Meta extends Record<string, unknown> = Record<string, unknown>,
>(options: Parameters<typeof createTicketingService>[0]) {
  return createTicketingService<TicketingEndpoints<Meta>>(options);
}
```

```ts
// host — the payload is now typed on requests and responses, no cast in sight
const ticketing = createTicketing<{ source: "email" | "web"; sla: number }>({ ... });
```

### Skip networking on the backend

When the host's own backend code needs the service, there's no HTTP round-trip — endpoints and service methods are directly callable in-process, sharing the same connection pool:

```ts
await ticketing.endpoints.createTicket({ body: { title: "x", summary: "y" } });
await ticketing.serviceMethods.closeStaleTickets({ olderThanDays: 30 });
```

### Return any web-standard response

Endpoints aren't limited to JSON. Serve full HTML pages for embedded UIs, server-sent event streams for real-time updates, file downloads, redirects — whatever `Response` supports. Build an entire admin dashboard that lives inside the host app.

## Database support

Futonic works with whatever database the host already runs — pass the driver connection and its provider:

- **PostgreSQL** via `pg`
- **MySQL** via `mysql2`
- **SQLite** via `better-sqlite3` or Bun's built-in `bun:sqlite`

## Entry points

| Import | Exports you'll use | Browser-safe |
| --- | --- | --- |
| `futonic` | `createFutonicServiceConstructor`, `defineService`, `generateServiceDrizzleSchema`, and db-schema types | No |
| `futonic/client` | `createClient`, `ClientOptions` | Yes |
| `futonic/drizzle` | `generateDrizzleSchema`, `DrizzleDialect`, and Drizzle types | No |

## License

MIT
