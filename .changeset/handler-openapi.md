---
"futonic": patch
---

The service `handler` now accepts an optional `openapi` option alongside `basePath` to configure the better-call router's OpenAPI reference route. It maps directly to better-call's router OpenAPI config (e.g. `{ disabled: false, path, scalar }`) and defaults to disabled, so `handler(req, { basePath: "/api/billing", openapi: { disabled: false } })` exposes the reference without changing existing behavior.
