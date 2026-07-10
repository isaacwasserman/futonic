---
"futonic": patch
---

Handler creation is now split from request handling: `service.createHandler({ basePath, openApi })` returns a `{ handle(request) }` handler instead of calling `service.handler(request, options)` per request. The OpenAPI reference is now enabled by default at `/reference`; pass `openApi: false` to disable it, or override better-call's router OpenAPI fields.
