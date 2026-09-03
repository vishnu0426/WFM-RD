import { AvayaAuraCollector, consoleLogger } from "./avaya-aura-collector";
import { loadConfigFromEnv } from "./config";
import { NatsBusCollector } from "./nats-bus-collector";
import { loadNatsBusConfigFromEnv } from "./nats-bus-config";

interface RunnableCollector {
  start(): Promise<void>;
  stop(): void;
}

/** `ACD_SOURCE` selects which input adapter runs - defaults to `avaya-aura` so an existing deployment's env doesn't need to change to keep working. */
function buildCollector(env: NodeJS.ProcessEnv): RunnableCollector {
  const source = env.ACD_SOURCE ?? "avaya-aura";
  if (source === "nats-bus") {
    return new NatsBusCollector(loadNatsBusConfigFromEnv(env));
  }
  if (source === "avaya-aura") {
    return new AvayaAuraCollector(loadConfigFromEnv(env));
  }
  throw new Error(
    `Unknown ACD_SOURCE "${source}" - expected "avaya-aura" or "nats-bus"`,
  );
}

async function main(): Promise<void> {
  const collector = buildCollector(process.env);
  await collector.start();

  const shutdown = (signal: string): void => {
    consoleLogger.info(`Received ${signal}, shutting down`);
    collector.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: Error) => {
  consoleLogger.error(`Fatal startup error: ${err.message}`);
  process.exit(1);
});
