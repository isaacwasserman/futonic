---
"futonic": patch
---

Prefix the Kysely schema keys so they match the generated physical table names. The Drizzle generator names tables `${serviceId}_${name}` and keys its members `${serviceId}${Capitalize<key>}`, but the Kysely schema was keyed by the bare logical name, so endpoints queried the wrong (unprefixed) table. The Kysely schema is now keyed by the same prefixed camelCase name, and the service id is threaded through as the prefix, so the `CamelCasePlugin` rewrites the key to the real physical table.
