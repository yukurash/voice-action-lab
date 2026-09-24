import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./demo-tests",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  outputDir: join(tmpdir(), `voice-action-lab-demo-tests-${process.pid}`),
  use: {
    ...(channel ? { channel } : {}),
    baseURL: "http://127.0.0.1:5176",
    viewport: { width: 1440, height: 1000 },
    screenshot: "off", video: "off", trace: "off",
  },
  webServer: {
    command: "npm run preview:demo",
    url: "http://127.0.0.1:5176/voice-action-lab/",
    reuseExistingServer: false,
  },
});
