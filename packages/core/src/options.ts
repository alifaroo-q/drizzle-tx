export type IsolationLevel =
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

export type AccessMode = 'read only' | 'read write';

export interface TxOptions {
  readonly isolationLevel?: IsolationLevel;
  readonly accessMode?: AccessMode;
  readonly deferrable?: boolean;
}

/** Options for `begin()` / `await using`: the SQL `TxOptions` plus scope-lifecycle controls. */
export interface BeginOptions extends TxOptions {
  /** Leak backstop (ADR-0014 R5): if the scope is not disposed within this many ms, force a
   *  default-deny rollback + release + loud warn. Default OFF (unset / non-finite = no backstop).
   *  A reclaim for a FORGOTTEN scope — not a work deadline; prefer `await using` so it never fires. */
  readonly disposeTimeoutMs?: number;
}
