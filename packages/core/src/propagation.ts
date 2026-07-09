export const Propagation = {
  Required: 'REQUIRED',
  RequiresNew: 'REQUIRES_NEW',
  Nested: 'NESTED',
} as const;

export type Propagation = (typeof Propagation)[keyof typeof Propagation];
