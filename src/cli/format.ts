import chalk from "chalk";
import Table from "cli-table3";

export function success(message: string): void {
  console.log(chalk.green(message));
}

export function failure(message: string): void {
  console.error(chalk.red(message));
}

export function printTable(headers: string[], rows: string[][]): void {
  const table = new Table({
    head: headers.map((h) => chalk.bold(h)),
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(row);
  }

  console.log(table.toString());
}

export function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
