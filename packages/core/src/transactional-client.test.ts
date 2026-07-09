import { describe, expect, it } from 'vitest';
import { createTransactionalClient } from './transactional-client.js';

describe('createTransactionalClient', () => {
  it('reads properties off the currently-active client (not a proxy receiver)', () => {
    // A class with a PRIVATE field accessed via a getter — mirrors Drizzle's shape.
    class Client {
      #secret: string;
      constructor(secret: string) {
        this.#secret = secret;
      }
      get value(): string {
        return this.#secret; // throws if `this` is a foreign object (the proxy)
      }
      echo(x: string): string {
        return `${this.#secret}:${x}`;
      }
    }
    let active = new Client('base');
    const proxy = createTransactionalClient<Client>(() => active);

    expect(proxy.value).toBe('base'); // getter must run on the real instance
    expect(proxy.echo('a')).toBe('base:a'); // method bound to real instance

    active = new Client('tx');
    expect(proxy.value).toBe('tx'); // resolves live, per access
    expect(proxy.echo('b')).toBe('tx:b');
  });
});
