# futonic-pgboss-dashboard

Embed [`@pg-boss/dashboard`](https://github.com/timgit/pg-boss/tree/master/packages/dashboard)
into a host application as a [futonic](../futonic) service. No subprocess,
no proxy hop, no extra container — the dashboard's Hono app runs in the same
process as your app.

## The problem

`@pg-boss/dashboard` ships as a built React Router 7 + Hono SSR app. Its
entry point (`build/server/index.js`) calls `@hono/node-server`'s `serve()`
as a module-level side effect, so the package has no programmatic export you
can mount into an existing framework.

## What this package does

- Imports `@pg-boss/dashboard/build/server/index.js` in-process.
- `createHonoServer` from `react-router-hono-server` returns the underlying
  Hono app even when it also auto-calls `serve()`, so we grab the app from
  the default export.
- Immediately closes the stray `net.Server` left over from `serve()` using
  `process._getActiveHandles()`, so no TCP listener leaks.
- Exposes `app.fetch(request)` as the service's request handler.

Result: the host mounts one path, requests are served by Hono directly with
no network hop and no dangling file descriptors.

## Install

```bash
npm install futonic-pgboss-dashboard @pg-boss/dashboard hono
```

`@pg-boss/dashboard` and `hono` are peer dependencies so they resolve from
the host's `node_modules` and match whatever version of `hono` the host is
already using.

## Usage

```ts
import { createHost } from "futonic";
import {
  pgbossDashboard,
  createPgBossDashboardRouter,
} from "futonic-pgboss-dashboard";
import { Hono } from "hono";

const dashboard = pgbossDashboard({
  mount: "/admin/queues",
  config: {
    databaseURL: process.env.DATABASE_URL!,
    schema: "pgboss",
    auth: {
      username: "admin",
      password: process.env.DASHBOARD_PASSWORD!,
    },
  },
});

const host = createHost({
  baseURL: "http://localhost:3000",
  services: [dashboard],
});

await host.init();

const router = createPgBossDashboardRouter(dashboard);

const app = new Hono();
app.all("/admin/queues/*", (c) => router.handler(c.req.raw));

process.on("SIGTERM", async () => {
  await host.shutdown();
});
```

## Configuration

| Option        | Type                     | Description                                                                    |
| ------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `databaseURL` | `string` (required)      | Postgres connection string. Supports `Name=url\|Name2=url2` for multi-DB.      |
| `schema`      | `string`                 | pg-boss schema name. Defaults to `pgboss`. Pipe-separated to match multi-DB.   |
| `auth`        | `{ username, password }` | Enables HTTP basic auth on the dashboard.                                      |

`databaseURL`, `schema`, and `auth` are set as `DATABASE_URL`,
`PGBOSS_SCHEMA`, and `PGBOSS_DASHBOARD_AUTH_USERNAME` / `_PASSWORD`
environment variables before the upstream module is imported, which is how
`@pg-boss/dashboard` consumes its configuration.

## How mounting works

The upstream dashboard is built with `basename: "/"` and has no build-time
option to change it, so the proxy handler strips your mount prefix from the
incoming path before handing the `Request` to `app.fetch`. A request at
`/admin/queues/jobs` becomes `/jobs` inside the dashboard.

The dashboard emits absolute URLs for client assets (e.g. `/assets/root-*.js`).
For those to resolve correctly when mounted under a sub-path, either mount
at `/` or add a pass-through route for the dashboard's asset paths. Mounting
behind a subdomain (`queues.myapp.com`) also works and keeps URLs clean.

## Runtime behaviour

- The stray HTTP listener spawned by the upstream's build is closed
  immediately after import via `process._getActiveHandles()`. This API is
  undocumented but has shipped in every Node release since 0.10; a warning
  is logged if the runtime does not expose it.
- The Hono app holds no external resources of its own. The dashboard opens
  its own `pg.Pool` on first request (via `DATABASE_URL`); it is separate
  from futonic's shared Kysely instance, so this service declares
  `dependencies: { database: false }`.
- Tested on Node 22. Bun is not supported because the upstream uses
  `react-dom/server`'s `renderToPipeableStream`, which Bun's `react-dom`
  shim does not implement.

## License

MIT
