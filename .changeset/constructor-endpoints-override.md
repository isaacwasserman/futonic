---
"futonic": minor
---

Let the service constructor take a call-time endpoints-override type argument. `createFutonicServiceConstructor(...)` now returns a constructor whose call signature accepts an optional `TEndpointsOverride` type parameter that re-types the returned `endpoints` (and therefore the typesafe client derived from them), defaulting to the endpoints inferred from the definition so existing calls are unchanged. A downstream service that parameterizes an endpoint's schema by a caller-supplied type (e.g. a typed metadata payload) can surface that type end-to-end by passing the matching re-typed endpoints, without an `as`-cast at the call site — the runtime endpoints are identical.
