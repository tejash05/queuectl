export type ShutdownHandler = (signal: NodeJS.Signals) => void;

/**
 * Register SIGINT/SIGTERM handlers once. Returns an disposer.
 */
export function onShutdown(handler: ShutdownHandler): () => void {
  const wrapped = (signal: NodeJS.Signals) => {
    handler(signal);
  };

  process.on("SIGINT", wrapped);
  process.on("SIGTERM", wrapped);

  return () => {
    process.off("SIGINT", wrapped);
    process.off("SIGTERM", wrapped);
  };
}
