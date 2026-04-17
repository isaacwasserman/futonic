# futonic-pgboss-dashboard

Embed [`@pg-boss/dashboard`](https://github.com/timgit/pg-boss/tree/master/packages/dashboard) into a host application as a [futonic](../futonic) service.

## The problem

`@pg-boss/dashboard` ships as a standalone Hono + React Router 7 app with a CLI
binary. It auto-starts an HTTP server on import and has no programmatic export
you can mount into an existing framework. If you want the dashboard alongside
an app you already run, you normally deploy a second container, set up an
internal port, and wire a reverse proxy yourself.

## What this package does

- Spawns `@pg-boss/dashboard` as a child process bound to a random localhost port.
- Reverse-proxies every request that hits the service's mount path to that subprocess.
- Ties the subprocess lifetime to your futonic host — one `init`, one `shutdown`.

The result: a single mount point in your router, no extra container, no extra deploy.

## Install

```bash
npm install futonic-pgboss-dashboard @pg-boss/dashboard
```

`@pg-boss/dashboard` is a peer dependency — install it in the host app so it
resolves from the host's `node_modules`.

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
    auth: { username: "admin", password: process.env.DASHBOARD_PASSWORD! },
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

| Option              | Type                                    | Description                                                                   |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `databaseURL`       | `string` (required)                     | Postgres connection string. Supports `Name=url\|Name2=url2` for multi-DB.     |
| `schema`            | `string`                                | pg-boss schema name. Defaults to `pgboss`. Pipe-separated to match multi-DB.  |
| `auth`              | `{ username, password }`                | Enables HTTP basic auth on the dashboard.                                     |
| `subprocessPort`    | `number`                                | Pin the subprocess port. A free port is chosen when omitted.                  |
| `subprocessHost`    | `string`                                | Interface the subprocess binds. Defaults to `127.0.0.1`.                      |
| `binPath`           | `string`                                | Override the resolved path to `@pg-boss/dashboard`'s CLI entry.               |
| `stdio`             | `"inherit" \| "pipe" \| "ignore"`       | Subprocess stdout/stderr handling. Defaults to `inherit`.                     |
| `startupTimeoutMs`  | `number`                                | How long to wait for the subprocess to open its port. Defaults to `15_000`.   |

## How mounting works

The dashboard is built with no `basename`, so internally it routes everything
from `/`. The proxy strips your mount prefix (`/admin/queues`) before
forwarding, so the dashboard sees requests as if it were at the root.

Because the dashboard emits absolute asset paths, the cleanest deployment is
to mount it at a path where `/assets/*` does not collide with other routes.
If you're mounting under a sub-path and see broken asset URLs, either run the
dashboard behind a subdomain (`queues.myapp.com`) or add a catch-all for its
asset paths.

## Shutdown

`host.shutdown()` kills the subprocess with `SIGTERM`, then `SIGKILL` after 5s
if it hasn't exited. The subprocess is also `unref`'d, so if you forget to call
`shutdown()` it still exits cleanly with the parent.

## License

MIT
