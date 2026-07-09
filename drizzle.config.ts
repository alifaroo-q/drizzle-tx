import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './test/schema.ts',
  out: './drizzle',
});
