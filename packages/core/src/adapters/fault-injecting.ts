/** A fake pg `DatabaseError`: a 5-char SQLSTATE `.code` + a string `.severity` — the exact
 *  structural markers `classifyCaught` reads (ADR-0012 §3). No `pg` import. */
export function fakePgError(
  code: string,
  message = `pg error ${code}`,
): { code: string; message: string; severity: string; routine: string; name: string } {
  return { code, message, severity: 'ERROR', routine: 'exec_simple_query', name: 'error' };
}

/** Code-less client-side socket loss (the drizzle/pg "Connection terminated" shape), or — when a
 *  libuv `code` is given — a raw socket error carrying `.syscall`. Both classify to ConnectionLost
 *  (socket-first precedence keeps `sqlState` undefined). */
export function socketError(opts?: { message?: string; code?: string }): Error {
  const e = new Error(opts?.message ?? 'Connection terminated unexpectedly');
  if (opts?.code) Object.assign(e, { code: opts.code, syscall: 'read' });
  return e;
}

export const pgSerializationFailure = () => fakePgError('40001', 'could not serialize access');
export const pgDeadlock = () => fakePgError('40P01', 'deadlock detected');
export const pgAdminShutdown = () => fakePgError('57P01', 'terminating connection due to administrator command');
