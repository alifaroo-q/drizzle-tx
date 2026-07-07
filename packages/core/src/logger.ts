export interface TxLogger {
  warn(message: string): void;
}

export const noopLogger: TxLogger = { warn: () => {} };

export const consoleLogger: TxLogger = {
  warn: (message) => {
    // biome-ignore lint/suspicious/noConsole: intentional library warning seam
    console.warn(`[drizzle-tx] ${message}`);
  },
};
