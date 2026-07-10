---
"futonic": patch
---

The service `handler` now takes a **required** second argument `{ basePath }` and strips it from the request URL before routing. Endpoints are defined at root paths, so a host mounting the service under a prefix passes `handler(req, { basePath: "/api/servicedesk" })` (or `{ basePath: "/" }` when mounted at root) instead of rewriting the URL itself. The mount path is supplied per request — not at construction — and it's required so a forgotten mount fails loudly rather than silently 404-ing every route.
