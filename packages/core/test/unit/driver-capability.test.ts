import { describe, expect, it } from 'vitest';
import {
  readDrizzleEntityKind,
  rejectUnsupportedDriver,
  UnsupportedDriverError,
} from '../../src/driver-capability.js';

// drizzle tags its DB classes with a STATIC global-registry symbol; these fakes model
// that exact shape (and a subclass chain) so the prototype-walk under test is real.
const ENTITY_KIND = Symbol.for('drizzle:entityKind');
// biome-ignore lint/complexity/noStaticOnlyClass: models drizzle's `static [entityKind]` tag
class NeonHttpDatabase {
  static [ENTITY_KIND] = 'NeonHttpDatabase';
}
// biome-ignore lint/complexity/noStaticOnlyClass: models drizzle's `static [entityKind]` tag
class NodePgDatabase {
  static [ENTITY_KIND] = 'NodePgDatabase';
}
class NeonHttpSubclass extends NeonHttpDatabase {} // no own entityKind → inherits parent's

describe('readDrizzleEntityKind', () => {
  it('reads the most-derived entityKind off the instance class chain', () => {
    expect(readDrizzleEntityKind(new NeonHttpDatabase())).toBe('NeonHttpDatabase');
    expect(readDrizzleEntityKind(new NodePgDatabase())).toBe('NodePgDatabase');
  });

  it('walks up to an inherited entityKind when the subclass has none', () => {
    expect(readDrizzleEntityKind(new NeonHttpSubclass())).toBe('NeonHttpDatabase');
  });

  it('returns undefined for clients with no entityKind', () => {
    expect(readDrizzleEntityKind({ transaction() {} })).toBeUndefined(); // hand-rolled client
    expect(readDrizzleEntityKind(null)).toBeUndefined();
    expect(readDrizzleEntityKind(undefined)).toBeUndefined();
    expect(readDrizzleEntityKind(42)).toBeUndefined();
  });
});

describe('rejectUnsupportedDriver', () => {
  it('throws UnsupportedDriverError for a known non-interactive driver (Neon HTTP)', () => {
    expect(() => rejectUnsupportedDriver(new NeonHttpDatabase())).toThrow(UnsupportedDriverError);
    try {
      rejectUnsupportedDriver(new NeonHttpDatabase());
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedDriverError);
      expect((e as UnsupportedDriverError).driver).toBe('NeonHttpDatabase');
      expect((e as UnsupportedDriverError).name).toBe('UnsupportedDriverError');
      expect((e as UnsupportedDriverError).message).toMatch(/neon-serverless/i);
    }
  });

  it('throws for a subclass of a non-interactive driver', () => {
    expect(() => rejectUnsupportedDriver(new NeonHttpSubclass())).toThrow(UnsupportedDriverError);
  });

  it('does NOT throw for interactive drivers or hand-rolled / testing clients', () => {
    expect(() => rejectUnsupportedDriver(new NodePgDatabase())).not.toThrow();
    expect(() => rejectUnsupportedDriver({ transaction() {} })).not.toThrow(); // no entityKind
    expect(() => rejectUnsupportedDriver(null)).not.toThrow();
  });
});
