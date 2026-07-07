# `@Transactional` resolves the TransactionHost via a process-global static registry

The `@Transactional` method decorator cannot use dependency injection — a method decorator runs at class-definition time with no access to the DI container. Instead, `TransactionHost` registers itself in a **process-global static `Map` keyed by connection name** in its constructor (during Nest bootstrap), and the decorator's `Proxy` `apply` trap looks it up **at call time**.

## Why

This is the only mechanism that lets a DI-less method decorator reach a DI-managed singleton. It is the same approach `nestjs-cls` uses, and it is what makes named/multiple connections additive later (the registry is already keyed by connection name).

## Consequences / constraints

- **Init timing:** normal request-time calls are always safe (the host is registered before `app.init()` resolves, including under `forRootAsync`). A transactional method invoked *during* bootstrap (e.g. inside another provider's `onModuleInit`, or a seed script) may run before registration → the decorator returns **`err(HostNotInitialized)`** (Result-consistent, never a throw, per ADR-0003).
- **Single app per process, per connection name.** Because the registry is process-global, two Nest apps in one process sharing a connection name would have the second overwrite the first. Unsupported in v1 and documented. Vitest's `forks` pool isolates each worker in its own process, so parallel integration tests (database-per-worker) are unaffected.

## Rejected alternative

A startup lifecycle hook that fails app boot if a transactional method could be reached pre-registration — rejected as over-engineered: reachability isn't statically knowable, and `err(HostNotInitialized)` already makes the failure explicit and matchable.
