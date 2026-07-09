import { defineRelations } from 'drizzle-orm';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  balance: integer('balance').notNull().default(0),
});

export const schema = { users, accounts };

// relations v2 — validate this exact call shape against installed rc.4 types.
export const relations = defineRelations(schema, (r) => ({
  users: { accounts: r.many.accounts({ from: r.users.id, to: r.accounts.userId }) },
  accounts: { user: r.one.users({ from: r.accounts.userId, to: r.users.id }) },
}));
