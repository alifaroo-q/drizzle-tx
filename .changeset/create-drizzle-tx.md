---
"@drizzle-tx/core": minor
"@drizzle-tx/nestjs": patch
---

Add `createDrizzleTx({ drizzle })` — the single non-DI canonical assembly path returning `{ db, withTransaction, begin, isActive, manager }`. Constructing against a non-interactive driver (Neon HTTP) now fails fast with a typed `UnsupportedDriverError` at assembly instead of a mysterious runtime throw. The NestJS module now sources its `TransactionManager` from `createDrizzleTx`, so defaults can't drift between surfaces (behavior-preserving).
