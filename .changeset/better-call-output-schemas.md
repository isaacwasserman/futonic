---
"futonic": minor
---

Endpoint validators are now converted to JSON Schema through the Standard Schema vendor interface, so zod/arktype request bodies and query parameters render accurately in the OpenAPI reference instead of falling back to a bare object. `defineEndpoint` gains an `output` option — a Standard Schema whose inferred type constrains the handler's return at compile time (not validated at runtime) and is emitted as the `200` response schema. `generateOpenApiDocument` is now async (the reference document is built lazily on first request, so `createHandler` remains synchronous).
