---
"@drizzle-tx/core": patch
---

Fixes:

- `FaultInjectingDrizzleAdapter.failOn`/`failOnce` now throw the error you pass
  verbatim. Previously they routed through the `{ error, times }` structural
  probe, so an error object that happened to carry an `.error` key was silently
  reinterpreted as a config and its inner `.error` thrown instead.
- `begin({ disposeTimeoutMs })` now treats a non-positive value (`0` / negative)
  as OFF instead of arming an immediate rollback of still-live work, and
  `disposeTimeoutMs` no longer leaks into the SQL adapter's `BEGIN` config.
- The scope leak-backstop no longer emits a misleading "not disposed" warning
  when the transaction already self-terminated (e.g. a connection drop) before
  dispose.
