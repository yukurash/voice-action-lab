import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
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
    command: "npm run dev -- --host localhost --port 5175",
    url: "http://localhost:5175",
    reuseExistingServer: false,
  },
});
