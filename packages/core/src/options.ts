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
