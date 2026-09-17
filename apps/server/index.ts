import { pathToFileURL } from "node:url";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

export { buildApp } from "./app.ts";
export { loadConfig, validateConfig } from "./config.ts";
export type { ServerConfig } from "./config.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = () => {
    void app.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: config.host, port: config.port });
  console.info("voice-action-lab server listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("voice-action-lab server startup failed; check private configuration");
    process.exitCode = 1;
  });
}
