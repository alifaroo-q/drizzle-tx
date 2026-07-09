import { NoOpDrizzleAdapter } from './noop-drizzle-adapter.js';

type TestClient = {
  readonly tag: 'client';
  query(sql: string): Promise<number>;
};

declare const client: TestClient;

const adapter = new NoOpDrizzleAdapter(client, { quiet: true });

const baseClient: TestClient = adapter.getBaseClient();
void baseClient;

adapter.wrapWithTransaction(undefined, async (tx) => {
  const typedTx: TestClient = tx;
  await typedTx.query('select 1');
  return 1;
});

adapter.wrapWithNestedTransaction(client, async (sp) => {
  const typedSp: TestClient = sp;
  await typedSp.query('select 1');
  return 1;
});
