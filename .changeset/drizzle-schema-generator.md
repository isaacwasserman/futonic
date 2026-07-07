---
"futonic": minor
---

Add a Drizzle schema generator. The new `futonic/drizzle` entry point exports `generateSchema(schema, dialect, serviceId)`, which converts a service's `ServiceDBSchema` into a record of Drizzle tables for the `postgres`, `mysql`, or `sqlite` dialect. Downstream services wrap it so hosts can feed the tables into their own Drizzle schema and generate migrations. `drizzle-orm` is added as an optional peer dependency.
