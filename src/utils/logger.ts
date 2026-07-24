import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  const details =
    meta && Object.keys(meta).length > 0
      ? " " +
        Object.entries(meta)
          .map(([k, v]) => `${k}=${stringify(v)}`)
          .join(" ")
      : "";
  return `${prefix} ${message}${details}`;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.QUEUECTL_DEBUG === "1") {
      console.error(chalk.gray(format("debug", message, meta)));
    }
  },

  info(message: string, meta?: Record<string, unknown>): void {
    console.error(chalk.cyan(format("info", message, meta)));
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    console.error(chalk.yellow(format("warn", message, meta)));
  },

  error(message: string, meta?: Record<string, unknown>): void {
    console.error(chalk.red(format("error", message, meta)));
  },
};
