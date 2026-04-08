# futonic

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

## How it works

You define a service as a bundle of **API endpoints** and **database tables**. Futonic handles the embedding.

```typescript
import { createService, createEndpoint } from "futonic";

const billing = createService({
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
  endpoints: {
    listInvoices: createEndpoint("/invoices", { method: "GET" }, async (ctx) => {
      const items = await ctx.context.serviceCtx.db.invoices.findMany();
      return { items };
    }),
    createInvoice: createEndpoint("/invoices", { method: "POST" }, async (ctx) => {
      const invoice = await ctx.context.serviceCtx.db.invoices.create(ctx.body);
      return invoice;
    }),
  },
});
```

Your users mount it in a few lines:

```typescript
import { createHost } from "futonic";
import { billing } from "@acme/billing";

const host = createHost({
  database: pool,  // Their existing pg.Pool, mysql2 pool, or sqlite instance
  baseURL: "http://localhost:3000",
  services: [
    billing({ mount: "/api/billing" }),
  ],
});

await host.init();
```

That's it. The billing service handles requests at `/api/billing/*` and stores data in the host's database under prefixed tables (`billing_invoices`, `billing_customers`, etc.) — no collisions, no conflicts.

## Features

### Web standard endpoints

Define endpoints as functions that return any web standard `Response` — JSON, HTML, streams, redirects, file downloads. No proprietary abstractions. Framework adapters (starting with [Next.js](https://nextjs.org)) let host developers wire up your service in one line:

```typescript
// Host's app/api/billing/[...path]/route.ts
import { toNextJsHandler } from "futonic/next";

export const { GET, POST, PUT, DELETE, PATCH } = toNextJsHandler(billingRouter);
```

### Prefixed database tables

Your service's tables are automatically prefixed with its ID. A `billing` service with an `invoices` table becomes `billing_invoices` in the actual database — no collisions with the host or other services. You interact with tables using their unprefixed names; the scoping is transparent.

```typescript
// You just write:
await ctx.db.invoices.findMany({ where: [{ field: "status", value: "paid" }] });
// Futonic queries `billing_invoices` under the hood
```

Ship a CLI so your users can generate migration files for their ORM of choice:

```bash
npx @acme/billing generate --orm=drizzle --provider=pg --out=schema.ts
npx @acme/billing generate --orm=prisma --provider=mysql
npx @acme/billing generate --orm=kysely --provider=sqlite
```

### Type safety end to end

Your service's schema, endpoint inputs, endpoint outputs, and client calls are all fully typed. Define your schema once and TypeScript carries it through to whoever consumes it.

### Skip networking on the backend

When the host's backend code calls your service, there's no HTTP round-trip. Your service runs in the same process, shares the same database connection pool, and returns results directly. Zero serialization overhead.

### Type-safe RPC from the frontend

Host developers consume your service from their frontend with a fully typed client:

```typescript
import { createClient } from "futonic/client";
import type { BillingRouter } from "@acme/billing";

const billing = createClient<BillingRouter>({
  baseURL: "/api/billing",
});

// Fully typed — autocomplete, return types, error types
const { data } = await billing.listInvoices();
const { data: invoice } = await billing.createInvoice({
  body: { amount: 4200, status: "draft" },
});
```

### Return any web standard response

Your endpoints aren't limited to JSON. Serve full HTML pages for embedded UIs, server-sent event streams for real-time updates, file downloads, redirects — whatever `Response` supports. Build an entire admin dashboard that lives inside the host app.

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
