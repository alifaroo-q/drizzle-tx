export interface TxLogger {
  warn(message: string): void;
}

export const noopLogger: TxLogger = { warn: () => {} };

export const consoleLogger: TxLogger = {
  warn: (message) => {
    console.warn(`[drizzle-tx] ${message}`);
  },
};
