---
"futonic": minor
---

Move `better-call` and `kysely` from dependencies to peer dependencies so hosts control their versions, and make the package's emitted type declarations portable under `--isolatedDeclarations` (the Drizzle column-builder factories now carry explicit return types).
