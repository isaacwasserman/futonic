---
"futonic": minor
---

`defineService` now returns a db-erased `ServiceBlueprint` instead of the full `ServiceDefinition`, and `createFutonicServiceConstructor` accepts that blueprint. Authoring keeps full `Kysely<Schema>` typing on `ctx.db` via `defineService`'s input, but the returned/exported definition no longer surfaces `Kysely<Schema>` — so a downstream service that exports its definition doesn't drag Kysely's full type surface into its published declarations. Callers must now go through `defineService` before `createFutonicServiceConstructor`.
