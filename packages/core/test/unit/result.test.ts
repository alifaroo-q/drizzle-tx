import { describe, expect, it } from 'vitest';
import {
  andThen,
  assertNever,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  match,
  ok,
  type Result,
  unwrapOr,
} from '../../src/result.js';

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

describe('Result combinators', () => {
  it('map transforms the ok value and passes err through', () => {
    expect(map(ok(2), (n) => n * 10)).toEqual({ ok: true, value: 20 });
    expect(map(err('boom'), (n: number) => n * 10)).toEqual({ ok: false, error: 'boom' });
  });

  it('mapErr transforms the error and passes ok through', () => {
    expect(mapErr(err('boom'), (e) => `${e}!`)).toEqual({ ok: false, error: 'boom!' });
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual({ ok: true, value: 1 });
  });

  it('andThen chains a fallible step, unioning the error types', () => {
    const parse = (n: number): Result<number, 'NEGATIVE'> => (n < 0 ? err('NEGATIVE') : ok(n + 1));
    expect(andThen(ok(1), parse)).toEqual({ ok: true, value: 2 });
    expect(andThen(ok(-1), parse)).toEqual({ ok: false, error: 'NEGATIVE' });
    expect(andThen(err('OUTER' as const), parse)).toEqual({ ok: false, error: 'OUTER' });
  });

  it('unwrapOr returns the value or the fallback', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('boom') as Result<number, string>, 0)).toBe(0);
  });

  it('match dispatches to the ok/err handler', () => {
    const describe_ = (r: Result<number, string>): string =>
      match(r, { ok: (v) => `ok:${v}`, err: (e) => `err:${e}` });
    expect(describe_(ok(3))).toBe('ok:3');
    expect(describe_(err('x'))).toBe('err:x');
  });
});
