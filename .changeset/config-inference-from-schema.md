---
"futonic": patch
---

Infer a service's config type from its `configSchema`'s **output** type. `defineService`/`createFutonicServiceConstructor` are now generic over the config *schema* (`TConfigSchema extends StandardSchemaV1<unknown, ServiceConfig>`) and derive `TConfig = StandardSchemaV1.InferOutput<TConfigSchema>`, instead of inferring `TConfig` from a `StandardSchemaV1<TConfig>` position (which collapsed to `Record<string, never>` because a schema's input and output types differ). Downstream services now get a correctly-typed `config` parameter with no manual annotation.
