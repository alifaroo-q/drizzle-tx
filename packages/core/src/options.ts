export interface TxOptions {
  readonly isolationLevel?:
    | 'read uncommitted'
    | 'read committed'
    | 'repeatable read'
    | 'serializable';
  readonly accessMode?: 'read only' | 'read write';
  readonly deferrable?: boolean;
}
