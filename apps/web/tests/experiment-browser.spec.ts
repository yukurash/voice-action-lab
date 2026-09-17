import { expect, test } from "@playwright/test";
import { disposeExperimentBrowser, openExperimentBrowser } from "../../../scripts/experiment-browser.ts";

const origin = "http://localhost:5175";
const modulePath = "/audioMeasurement.worklet-synthetic.js";
const moduleCode = `registerProcessor("synthetic-auth-probe", class extends AudioWorkletProcessor {
  process() { return false; }
});`;

for (const scenario of [
  { name: "loads authenticated code without changing its processor", status: 200, mime: "application/javascript", body: moduleCode, error: null },
  { name: "rejects an authentication failure", status: 401, mime: "application/javascript", body: moduleCode, error: "authenticated_worklet_response_invalid" },
  { name: "rejects login HTML instead of treating it as code", status: 200, mime: "text/html", body: "<html>synthetic login</html>", error: "authenticated_worklet_response_invalid" },
  { name: "bounds the downloaded module", status: 200, mime: "application/javascript", body: " ".repeat(256 * 1024 + 1), error: "authenticated_worklet_too_large" },
]) {
  test(`bearer worklet bridge ${scenario.name}`, async () => {
    const experiment = await openExperimentBrowser(origin, "synthetic-token");
    const requests: { authorization: string | undefined; origin: string | undefined }[] = [];
    try {
      await experiment.context.route(`${origin}/`, (route) => route.fulfill({ contentType: "text/html", body: "<html><body>synthetic</body></html>" }));
      await experiment.context.route(`${origin}${modulePath}`, (route) => {
        const headers = route.request().headers();
        requests.push({ authorization: headers.authorization, origin: headers.origin });
        return route.fulfill({ status: scenario.status, contentType: scenario.mime, body: scenario.body });
      });
      await experiment.page.goto(origin);
      const result = await experiment.page.evaluate(async (path) => {
        const context = new AudioContext();
        try {
          await context.audioWorklet.addModule(path, { credentials: "same-origin" });
          const processor = new AudioWorkletNode(context, "synthetic-auth-probe");
          processor.disconnect();
          processor.port.close();
          return null;
        } catch (failure) {
          return failure instanceof Error ? failure.message : "unexpected_error";
        } finally {
          await context.close();
        }
      }, modulePath);
      expect(result).toBe(scenario.error);
      expect(requests).toEqual([{ authorization: "Bearer synthetic-token", origin }]);
      expect(experiment.routes).toEqual([]);
    } finally {
      await disposeExperimentBrowser(experiment);
    }
  });
}

test("bearer worklet bridge refuses off-origin and arbitrary source paths", async () => {
  const experiment = await openExperimentBrowser(origin, "synthetic-token");
  try {
    await experiment.context.route(`${origin}/`, (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
    await experiment.page.goto(origin);
    const failures = await experiment.page.evaluate(async () => {
      const context = new AudioContext();
      const failures: string[] = [];
      try {
        for (const path of ["https://outside.invalid/audioMeasurement.worklet-synthetic.js", "/arbitrary.js", "/audioMeasurement.worklet-synthetic.js?secret=x"]) {
          try {
            await context.audioWorklet.addModule(path);
            failures.push("unexpected_success");
          } catch (failure) {
            failures.push(failure instanceof Error ? failure.message : "unexpected_error");
          }
        }
        return failures;
      } finally {
        await context.close();
      }
    });
    expect(failures).toEqual(Array<string>(3).fill("unexpected_authenticated_worklet"));
  } finally {
    await disposeExperimentBrowser(experiment);
  }
});
