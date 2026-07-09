# `@Transactional` is typed to force `DrizzleTxError` into the method's error union

A legacy (`experimentalDecorators`) TypeScript method decorator cannot change the decorated method's caller-visible return type. But `@Transactional` can, at runtime, produce infrastructure errors (`PoolConnectionTimeout`, `TransactionAborted`, `HostNotInitialized`, `NotPoolBacked`). If the method's declared error union doesn't include those, they are runtime-present but type-invisible — and an exhaustive `switch`/`assertNever` in the controller would compile as "complete" while silently missing them.

## Decision

Type the decorator so it **only accepts methods whose declared return is `Promise<Result<T, E>>` with `DrizzleTxError extends E`**. A decorated method whose error union omits `DrizzleTxError` fails to compile. This preserves end-to-end exhaustiveness (the controller's match is genuinely complete) despite the decorator's inability to widen the type. The fully-typed imperative `withTransaction()` — whose return type explicitly includes `DrizzleTxError` — remains available as the primary type-safe path and escape hatch.

## Why this matters

This closes the one hole that would otherwise defeat the whole explicit-Result guarantee (ADR-0003): an infra error surfacing as an `err` variant no caller ever matched.

## Risk / fallback

Legacy-decorator generic inference is limited. If the constraint cannot be *enforced* at compile time under `experimentalDecorators` (validated in the Phase-1 spike), the fallback is: make `withTransaction()` the blessed type-safe path, and ship the decorator with a documented "your method's error union must include `DrizzleTxError`" rule plus a lint guard — accepting that the decorator's safety is then convention-checked rather than compiler-enforced.
