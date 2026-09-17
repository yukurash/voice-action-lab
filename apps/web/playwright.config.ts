import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(tmpdir(), `voice-action-lab-web-tests-${process.pid}`),
  use: {
    ...(channel ? { channel } : {}),
    baseURL: "http://localhost:5175",
    screenshot: "off",
    video: "off",
    trace: "off",
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: process.env.PLAYWRIGHT_BUILT_CLIENT === "1"
      ? "npm run preview -- --host localhost --port 5175"
      : "npm run dev -- --host localhost --port 5175",
    url: "http://localhost:5175",
    reuseExistingServer: false,
  },
});
