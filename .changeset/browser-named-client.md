---
"futonic": minor
---

Make the name-keyed client browser-safe and add codegen for a static client. `createClientFromManifest` (renamed from `createNamedClient`) takes a plain, serializable route manifest (`NamedClientRoutes`) instead of the live `endpoints` object, so building it pulls no handlers, schemas, or db code into the browser bundle; it and `toNamedClientRoutes` are re-exported from `futonic/client`. A new `generateNamedClientModule`/`extractClientRoutes` pair lets a downstream service emit a static, type-branded manifest module at build time (constructors now expose `.definition` to support this), and the runtime `service.clientRoutes` field is removed since it could never reach the browser without server code. Adds a package README documenting the service-developer and host-developer workflows.
