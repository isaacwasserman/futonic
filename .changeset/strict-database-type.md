---
"futonic": minor
---

Type a service's `database` config as a Drizzle instance instead of `any`. Hosts now pass the value returned by `drizzle(...)`; futonic reads the underlying driver off the instance's `$client` and opens its own Kysely connection, so dialect auto-detection is unchanged. The exported `DatabaseConnection` type (the extracted driver) is also tightened from `any` to a structural union, and a new `DrizzleDatabase` type is exported.
