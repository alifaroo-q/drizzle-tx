import type { TxPlan } from './propagation-plan.js';
import { assertNever } from './result.js';

// If a TxPlan variant is added without a case here, this fails to compile — proving exhaustiveness.
export function describePlan(plan: TxPlan): string {
  switch (plan.kind) {
    case 'join':
      return 'join';
    case 'new-root':
      return 'new-root';
    case 'nested':
      return 'nested';
    case 'reject':
      return `reject:${plan.error.kind}`;
    default:
      return assertNever(plan);
  }
}
