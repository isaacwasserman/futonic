---
"futonic": minor
---

Make the name-keyed client browser-safe and add codegen for a static client. `createNamedClient` now takes a plain, serializable route manifest (`NamedClientRoutes`) instead of the live `endpoints` object, so building it pulls no handlers, schemas, or db code into the browser bundle; `createNamedClient` and `toNamedClientRoutes` are also re-exported from `futonic/client`. A new `generateNamedClientModule`/`extractClientRoutes` pair lets a downstream service emit a static, type-branded manifest module at build time (constructors now expose `.definition` to support this), and the runtime `service.clientRoutes` field is removed since it could never reach the browser without server code.
