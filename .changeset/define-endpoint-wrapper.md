---
"futonic": minor
---

Replace the `endpoints` `use` argument with a `defineEndpoint` helper. Services now define endpoints with a `createEndpoint` that already carries the service middleware, instead of receiving a `use` middleware array to spread into each endpoint. This mirrors the existing `serviceMethods(define)` pattern and removes per-endpoint middleware wiring, while handlers keep reading `ctx.context.serviceCtx` (typed `{ db, config, logger }`).
