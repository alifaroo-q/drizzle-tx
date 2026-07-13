import * as core from '../../src/index.js';

// `assertNever` is deliberately NOT part of the public barrel (Tier A/B surface) — consumers use
// `matchError` for DrizzleTxError exhaustiveness. If someone re-exports it from index.ts, the RHS
// stops erroring, the @ts-expect-error goes unused, and this file fails to compile.
// @ts-expect-error — assertNever must not be publicly importable from @drizzle-tx/core
export const _noPublicAssertNever = core.assertNever;

// Sanity: genuinely-public members still resolve, so a wrong import path can't silently satisfy
// the guard above by making EVERY access error.
export const _publicSettle = core.settle;
export const _publicMatchError = core.matchError;
