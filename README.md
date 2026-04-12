# Futonic 🛋️

**A framework for building services that embed into host applications instead of deploying alongside them.**

## The problem

There are plenty of services available as easy-to-deploy containers — auth servers, payment processors, observability tools. But for most applications, deploying multiple containers (one for the main app plus one for each service) is a waste. An auth server, a payment webhook handler, and an observability stack don't each need their own process. They could share compute and a database without any meaningful noisy-neighbor issues — because let's be honest, most apps these days are just wrappers around heavier services anyway.

## The idea

Futonic is heavily inspired by [better-auth](https://github.com/better-auth/better-auth)'s service embedding paradigm — the insight that many services don't need their own process, their own deployment, or even their own database. They just need a place to crash.

Futonic is a framework for building **embeddable services** that crash on a host application's futon. They share the host's compute. They share the host's database. They wake up when needed and stay out of the way when they're not.

No separate containers. No extra Dockerfiles. No internal networking. Just services that live inside the host app — and a great DX for building them.

## Why build embeddable services

**Your users save money:**
Most apps aren't mega-scale. They're tools, SaaS products, and indie projects where every dollar of infrastructure counts. When your service embeds directly into the host, your users don't need to pay for another container sitting idle 99% of the time.

**Your users get a better dev experience:**
No more `docker-compose up` with 6 services just to work on a feature. No more debugging why the auth container can't talk to the payments container on a laptop. Embedded services run in-process. Switch branches, switch worktrees — everything just works.

**Simplicity sells:**
Fewer moving parts means fewer things that break at 2am. One deploy. One database. One set of logs. Developers can always decompose later if they outgrow it — but most apps never will. The easier your service is to adopt, the more people will use it.

## How it works: a vertical slice

The best way to understand futonic is to follow a single request all the way through — from the browser to the database and back. Here's what happens when someone creates an invoice by hitting `POST /api/billing/invoices`.

### Layer 1: The service author defines tables and endpoints

A futonic service is a bundle of database tables and API endpoints. The service author publishes this as an npm package.

```typescript
// @acme/billing — the service package

import { createService, createEndpoint } from "futonic";

export const billing = createService({
  id: "billing",
  version: "0.1.0",
  dependencies: { database: true },
  dbSchema: {
    tables: {
      invoices: {
        fields: {
          id: { type: "string", primaryKey: true, required: true },
          amount: { type: "number", required: true },
          status: { type: "string", required: true },
        },
      },
    },
  },
});
```

Endpoints are defined as functions that receive a `ServiceContext` via middleware — giving them access to the database, config, and logger:

```typescript
export function createBillingEndpoints(use: Middleware[]) {
  return {
    createInvoice: createEndpoint(
      "/invoices",
      { method: "POST", use, body: z.object({ amount: z.number(), status: z.string() }) },
      async (ctx) => {
        const svc = ctx.context.serviceCtx;
        const invoice = await svc.db.invoices.create({
          id: crypto.randomUUID(),
          ...ctx.body,
        });
        svc.logger.info(`Invoice created: ${invoice.id}`);
        return invoice;
      },
    ),
  };
}
```

### Layer 2: The host developer mounts the service

The host developer installs the service and wires it into their app. Futonic auto-detects their database driver — `pg`, `mysql2`, `better-sqlite3`, or `bun:sqlite`.

```typescript
import { createHost } from "futonic";
import { billing, createBillingRouter } from "@acme/billing";

// Mount the service and initialize
const host = createHost({
  database: pool,  // Their existing pg.Pool, mysql2 pool, or sqlite instance
  baseURL: "http://localhost:3000",
  services: [
    billing({ mount: "/api/billing" }),
  ],
});

await host.init();
```

### Layer 3: The framework catch-all routes to futonic

The host developer adds a single catch-all route in their framework of choice. All requests under the mount path flow into the service's router.

```typescript
// Hono
app.all("/api/billing/*", (c) => billingRouter.handler(c.req.raw));

// Next.js — app/api/billing/[...path]/route.ts
import { toNextJsHandler } from "futonic/next";
export const { GET, POST, PUT, DELETE, PATCH } = toNextJsHandler(billingRouter);
```

### Layer 4: Middleware injects the service context

When a request hits `POST /api/billing/invoices`, futonic's middleware runs before the endpoint handler. It attaches the `ServiceContext` — the service's window into the host:

```typescript
ctx.context.serviceCtx = {
  db,        // Database adapter scoped to this service's prefixed tables
  config,    // Mount-time configuration
  logger,    // Logger prefixed with [futonic:billing]
  hostInfo,  // { baseURL, mountPath }
};
```

The endpoint handler never touches the raw database or knows which framework it's running in. It just uses `ctx.context.serviceCtx`.

### Layer 5: The endpoint handler runs

The `createInvoice` handler receives the validated request body (via Zod) and the injected service context. It calls `svc.db.invoices.create(...)` — using the unprefixed table name.

```typescript
async (ctx) => {
  const svc = ctx.context.serviceCtx;
  const invoice = await svc.db.invoices.create({
    id: crypto.randomUUID(),
    ...ctx.body,
  });
  svc.logger.info(`Invoice created: ${invoice.id}`);
  //=> [futonic:billing] Invoice created: 7f2a...
  return invoice;
}
```

### Layer 6: The database layer translates to prefixed tables

Under the hood, `svc.db.invoices` is a proxy that rewrites all queries to target `billing_invoices` — the table name prefixed with the service ID. This is how multiple services share one database without collisions.

```
svc.db.invoices.create({ id: "7f2a...", amount: 4200, status: "draft" })
                  ↓
INSERT INTO billing_invoices (id, amount, status) VALUES ('7f2a...', 4200, 'draft')
                  ↓
RETURNING *
```

A second service with its own `invoices` table would query `other_service_invoices` — completely isolated, same database.

### Layer 7: The response flows back

The return value from the handler is serialized to JSON and sent back as a standard `Response`. The client sees:

```json
{
  "id": "7f2a...",
  "amount": 4200,
  "status": "draft"
}
```

### The full picture

```
Browser                 Framework           Futonic                    Database
  │                        │                   │                          │
  │  POST /api/billing/    │                   │                          │
  │  invoices              │                   │                          │
  │───────────────────────>│                   │                          │
  │                        │  catch-all route  │                          │
  │                        │──────────────────>│                          │
  │                        │                   │  middleware injects      │
  │                        │                   │  ServiceContext          │
  │                        │                   │                          │
  │                        │                   │  Zod validates body      │
  │                        │                   │                          │
  │                        │                   │  handler calls           │
  │                        │                   │  db.invoices.create()    │
  │                        │                   │                          │
  │                        │                   │  INSERT INTO             │
  │                        │                   │  billing_invoices ──────>│
  │                        │                   │                          │
  │                        │                   │  <── row returned ───────│
  │                        │                   │                          │
  │  <── 200 JSON ─────────│<──────────────────│                          │
  │                        │                   │                          │
```

Every layer has a single job. The service author writes endpoints and schemas. The host developer mounts and routes. Futonic handles context injection, table prefixing, and database driver detection. Nothing leaks across boundaries.

## More features

### Type-safe RPC from the frontend

Host developers consume your service from their frontend with a fully typed client — autocomplete, return types, and error types included:

```typescript
import { createClient } from "futonic/client";
import type { BillingRouter } from "@acme/billing";

const billing = createClient<BillingRouter>({
  baseURL: "/api/billing",
});

const { data } = await billing.listInvoices();
const { data: invoice } = await billing.createInvoice({
  body: { amount: 4200, status: "draft" },
});
```

### Skip networking on the backend

When the host's backend code needs to call the service, there's no HTTP round-trip. The service runs in the same process, shares the same database connection pool, and returns results directly:

```typescript
const svc = host.services.get("billing").serviceContext!;
const invoices = await svc.db.invoices.findMany();
```

### Generate migrations for any ORM

Ship a CLI so your users can generate migration files for their ORM of choice:

```bash
npx @acme/billing generate --orm=drizzle --provider=pg --out=schema.ts
npx @acme/billing generate --orm=prisma --provider=mysql
npx @acme/billing generate --orm=kysely --provider=sqlite
```

### Return any web standard response

Endpoints aren't limited to JSON. Serve full HTML pages for embedded UIs, server-sent event streams for real-time updates, file downloads, redirects — whatever `Response` supports. Build an entire admin dashboard that lives inside the host app.

## Things you could build

- **Auth service** — User management, sessions, OAuth flows, and permissions. Like better-auth, but packaged as an embeddable service.
- **Payment service** — Webhook handlers, invoice management, subscription state. A reusable Stripe integration that anyone can drop into their app.
- **Observability service** — An API for ingesting traces, database tables for storing them, and an embedded UI for visualizing them. Jaeger without the deployment.
- **Feature flags** — A flag service with an admin UI, backed by the host's existing database.
- **CMS** — Content management endpoints with an embedded editor interface.
- **Notifications** — Email/push queue management with status tracking and retry logic.

## Database support

Futonic auto-detects your database driver and works with:

- **PostgreSQL** via `pg`
- **MySQL** via `mysql2`
- **SQLite** via `better-sqlite3` or Bun's built-in `bun:sqlite`

Your service works with whatever database the host is already running — no extra configuration on your end.

## License

MIT
