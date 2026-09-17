import { AzureCliCredential } from "@azure/identity";
import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveExternalOutputPath } from "../packages/experiments/index.ts";
import { FIXTURE_SET_VERSION, SYNTHETIC_FIXTURES } from "../tests/synthetic-scenarios.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      subscription: { type: "string" }, tenant: { type: "string" },
      endpoint: { type: "string" }, "resource-id": { type: "string" }, out: { type: "string" },
    },
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!values.subscription || !uuid.test(values.subscription) || !values.tenant || !uuid.test(values.tenant)
    || !values.endpoint || !values["resource-id"] || !values.out) {
    throw new Error("Supply --subscription UUID --tenant UUID --endpoint HTTPS_URL --resource-id ARM_ID --out ABSOLUTE_DIRECTORY");
  }
  const endpoint = new URL(values.endpoint);
  if (endpoint.protocol !== "https:" || !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("Use a dedicated Azure Speech HTTPS resource endpoint.");
  }
  const resourcePattern = new RegExp(`^/subscriptions/${values.subscription}/resourceGroups/[a-z0-9_.()-]+/providers/Microsoft\\.CognitiveServices/accounts/[a-z0-9-]+$`, "i");
  if (!resourcePattern.test(values["resource-id"])) throw new Error("Speech resource ID must belong to the explicitly selected subscription.");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = await resolveExternalOutputPath(values.out, repository);
  try {
    await access(output);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    await mkdir(output, { recursive: true });
  }
  for (const file of [...SYNTHETIC_FIXTURES.map((fixture) => `${fixture.id}.wav`), "manifest.json"]) {
    let exists = false;
    try {
      await access(resolve(output, file));
      exists = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (exists) throw new Error("Output already contains fixtures; choose a new directory to preserve previous data.");
  }
  const credential = new AzureCliCredential({ subscription: values.subscription });
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  const claims: unknown = JSON.parse(Buffer.from(token.token.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!claims || typeof claims !== "object" || !("tid" in claims)
    || typeof claims.tid !== "string" || claims.tid.toLowerCase() !== values.tenant.toLowerCase()) {
    throw new Error("Azure CLI credential does not belong to the requested tenant.");
  }
  const voice = "ja-JP-NanamiNeural";
  const fixtures = [];
  for (const fixture of SYNTHETIC_FIXTURES) {
    const path = await resolveExternalOutputPath(resolve(output, `${fixture.id}.wav`), repository);
    const response = await fetch(new URL("/tts/cognitiveservices/v1", endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer aad#${values["resource-id"]}#${token.token}`,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
      },
      body: `<speak version="1.0" xml:lang="ja-JP"><voice name="${voice}">${fixture.text}</voice></speak>`,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Speech synthesis failed: HTTP ${response.status}`);
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Speech did not return the requested WAV format.");
    }
    await writeFile(path, audio, { flag: "wx" });
    fixtures.push({ ...fixture, file: `${fixture.id}.wav`, bytes: audio.length, sha256: createHash("sha256").update(audio).digest("hex") });
    console.log(`${fixture.id}: ${audio.length} bytes`);
  }
  await writeFile(await resolveExternalOutputPath(resolve(output, "manifest.json"), repository), JSON.stringify({
    version: FIXTURE_SET_VERSION, voice, provider: "Azure Speech", sampleRate: 24_000, format: "riff-24khz-16bit-mono-pcm", fixtures,
  }, null, 2), { flag: "wx" });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fixture generation failed.");
  process.exitCode = 1;
});
