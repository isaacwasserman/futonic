---
"futonic": minor
---

Decouple Drizzle schema generation from service construction. The Drizzle schema depends only on the service definition and dialect, not on runtime config or a database connection, so `drizzleSchema` is removed from the constructor output and replaced by a standalone `generateServiceDrizzleSchema(definition, dialect)`. A new `defineService` identity helper captures a definition once so it can be shared between `createFutonicServiceConstructor` and the schema generator; downstream services wrap `generateServiceDrizzleSchema` to bake in their definition, leaving hosts to pass just the dialect.
