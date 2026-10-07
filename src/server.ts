import { loadConfig } from "./config/env.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const app = createApp(config);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10000);
      deadline.unref();
      void app.close().then(() => { clearTimeout(deadline); }).catch(() => process.exit(1));
    });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
}
main().catch(() => {
  console.error("Service startup failed. Check environment configuration, port and file permissions.");
  process.exitCode = 1;
});
