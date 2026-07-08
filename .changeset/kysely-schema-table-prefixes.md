---
"futonic": patch
---

Apply the service's table prefix to Kysely queries at runtime. The Drizzle generator names physical tables `${serviceId}_${name}`, but Kysely queried the bare logical name and so hit the wrong (unprefixed) table. The service id is now threaded through to `createKysely` as a prefix, and a `TablePrefixPlugin` rewrites each table reference to its physical `${serviceId}_${name}` name at query time. Endpoints keep querying the bare logical name, so the Kysely schema type is unchanged.
