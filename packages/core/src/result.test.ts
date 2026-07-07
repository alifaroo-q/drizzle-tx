import { describe, expect, it } from 'vitest';
import { assertNever, err, isErr, isOk, ok, type Result } from './result.js';

describe('Result', () => {
  it('ok wraps a value with ok:true', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });
  it('err wraps an error with ok:false', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });
  it('isOk / isErr narrow correctly', () => {
    const r: Result<number, string> = ok(1);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) expect(r.value).toBe(1); // type-narrowed access compiles
  });
  it('assertNever throws with the offending value serialized', () => {
    expect(() => assertNever('x' as never)).toThrowError(/Unhandled variant: "x"/);
  });
});
