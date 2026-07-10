---
"futonic": patch
---

Re-export the `better-call` surface types futonic exposes through its public API (`export type * from "better-call"`). A downstream service that re-exports futonic (`export type * from "futonic"`) then makes every type appearing in its service factory's signature nameable to *its* consumers via its own package path — so the service can ship portable declarations from a plain `tsc` build, with no declaration bundler and no `better-call` peer dependency.
