import { FaultInjectingDrizzleAdapter, type TxPhase } from '../../src/adapters/fault-injecting.js';

type TestClient = { readonly tag: 'client'; query(sql: string): Promise<number> };
declare const client: TestClient;

const a = new FaultInjectingDrizzleAdapter(client, { failAt: { commit: new Error('x') }, quiet: true });
const base: TestClient = a.getBaseClient();
void base;

// fluent API returns `this` (chainable) and the client type is preserved through the seam:
a.failOn('rollback', new Error('y')).failOnce('begin', new Error('z')).clear();
a.wrapWithTransaction(undefined, async (tx) => {
  const t: TestClient = tx;
  return t.query('select 1');
});

// TxPhase is the 6-member union (a wrong literal is rejected):
const p: TxPhase = 'rollback-to-savepoint';
void p;
// @ts-expect-error — not a valid phase
const bad: TxPhase = 'COMMIT';
void bad;
