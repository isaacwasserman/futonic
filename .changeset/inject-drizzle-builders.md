---
"futonic": minor
---

`generateServiceDrizzleSchema` (and the underlying `generateDrizzleSchema`) now take the host's drizzle dialect module as an argument — e.g. `generateServiceDrizzleSchema(def, "pg", pgCore)` where `pgCore` is `import * as pgCore from "drizzle-orm/pg-core"`. futonic no longer imports `drizzle-orm` itself, so the generated tables are built from and typed against the *host's* drizzle-orm: there is no version coupling, the tables are nameable through the host's own package, and no `drizzle-orm` peer dependency is required. Column SQL names are snake_cased to match the runtime Kysely instance's `CamelCasePlugin` (a logical `userId` column becomes `user_id`), so the host-created tables line up with the service's queries. Tables come back as the host's base table type (`PgTable`/`MySqlTable`/`SQLiteTable`); drizzle-kit reads the runtime objects for migrations.
