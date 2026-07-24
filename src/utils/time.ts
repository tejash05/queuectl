export function nowIso(): string {
  return new Date().toISOString();
}

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function isBefore(iso: string, otherIso: string): boolean {
  return new Date(iso).getTime() < new Date(otherIso).getTime();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
