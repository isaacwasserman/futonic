# futonic

**Embed services into your app instead of deploying them next to it.**

## The problem

You need auth. You need payments. You need observability. Each one comes as a container you deploy alongside your app. Now you're managing a fleet of services for an app that gets 200 requests a day.

Your "microservices" aren't doing micro work — they're sitting idle, eating memory, and costing you money. You don't need horizontal scale. You need your stuff to work.

## The idea

Futonic is heavily inspired by [better-auth](https://github.com/better-auth/better-auth)'s service embedding paradigm — the insight that many services don't need their own process, their own deployment, or even their own database. They just need a place to crash.

Futonic lets developers create **embeddable services** that crash on a host application's futon. They share your compute. They share your database. They wake up when needed and stay out of the way when they're not.

No separate containers. No extra Dockerfiles. No internal networking. Just services that live inside your app.

## Why this makes sense

**For small-scale apps and indie projects:**
Most apps aren't Twitter. They're tools, SaaS products, and side projects where every dollar of infrastructure counts. Running a Postgres instance, an auth server, a payment webhook handler, and an observability stack as separate containers is overkill when your app and all its services could comfortably share a single process and a single database.

**For local development:**
No more `docker-compose up` with 6 services just to work on a feature. No more debugging why the auth container can't talk to the payments container on your laptop. Every service runs in-process. Switch branches, switch worktrees — everything just works.

**For keeping things simple:**
Fewer moving parts means fewer things that break at 2am. One deploy. One database. One set of logs. You can always decompose later if you outgrow it — but most apps never will.

## How it works

A futonic service is a bundle of **API endpoints** and **database tables** that plugs into any host application.

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

The host application mounts it:

```typescript
import { createHost } from "futonic";
import { billing } from "@acme/billing";

const host = createHost({
  database: pool,  // Your existing pg.Pool, mysql2 pool, or sqlite instance
  baseURL: "http://localhost:3000",
  services: [
    billing({ mount: "/api/billing" }),
  ],
});

await host.init();
```

That's it. The billing service now handles requests at `/api/billing/*` and stores data in your database under prefixed tables (`billing_invoices`, `billing_customers`, etc.) — no collisions, no conflicts.

## Features

### Web standard endpoints

Endpoints are just functions that take a `Request` and return a `Response`. Return JSON, HTML, streams, redirects — anything the web platform supports. Adapters for [Next.js](https://nextjs.org) are included, with more on the way.

```typescript
// Works with Next.js App Router
// app/api/billing/[...path]/route.ts
import { toNextJsHandler } from "futonic/next";

export const { GET, POST, PUT, DELETE, PATCH } = toNextJsHandler(billingRouter);
```

### Prefixed database tables

Each service's tables are automatically prefixed with its service ID. A `billing` service with an `invoices` table gets `billing_invoices` in the actual database. Services interact with their tables using the unprefixed name — the scoping is transparent.

```typescript
// Inside the service, you just write:
await ctx.db.invoices.findMany({ where: [{ field: "status", value: "paid" }] });
// Futonic queries `billing_invoices` under the hood
```

Schema generation is built in. Service authors ship a CLI that host developers use to generate the right migration files for their ORM of choice:

```bash
npx @acme/billing generate --orm=drizzle --provider=pg --out=schema.ts
npx @acme/billing generate --orm=prisma --provider=mysql
npx @acme/billing generate --orm=kysely --provider=sqlite
```

### Type safety end to end

Service schemas, endpoint inputs, endpoint outputs, and client calls are all fully typed. Define your schema once and TypeScript carries it through to the client.

### Skip networking on the backend

When your backend code interacts with an embedded service, there's no HTTP round-trip. The service runs in the same process, shares the same database connection pool, and returns results directly. Zero serialization overhead.

### Type-safe RPC from the frontend

Consume any embedded service from your frontend with a fully typed client:

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

Endpoints aren't limited to JSON. Return full HTML pages for embedded UIs, server-sent event streams for real-time updates, file downloads, redirects — whatever `Response` supports.

## Things you might embed

- **Auth** — User management, sessions, OAuth flows, and permissions. Like better-auth, but as a service you embed rather than a library you import.
- **Payments** — Webhook handlers, invoice management, subscription state. Keep your Stripe integration contained and reusable across projects.
- **Observability** — Ingest traces via an embedded API, store them in your database, visualize them through an embedded UI. No Jaeger deployment required.
- **Feature flags** — A simple flag service with an admin UI, backed by your existing database.
- **CMS** — Content management endpoints with an embedded editor interface.
- **Notifications** — Email/push queue management with status tracking and retry logic.

## Database support

Futonic auto-detects your database driver and works with:

- **PostgreSQL** via `pg`
- **MySQL** via `mysql2`
- **SQLite** via `better-sqlite3` or Bun's built-in `bun:sqlite`

Pass your existing connection — no extra configuration needed.

## License

MIT
