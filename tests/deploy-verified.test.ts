import assert from "node:assert/strict";
import test from "node:test";
import { deploymentConfiguration, releaseOperations } from "../scripts/deploy-verified.ts";
import { AzureMaintenanceError } from "../scripts/maintenance-azure.ts";
import type { AzureMaintenanceOptions, AzureMaintenanceResult } from "../scripts/maintenance-azure.ts";

const configuration = deploymentConfiguration({
  AZURE_REGISTRY_NAME: "exampleacr", RELEASE_DIGEST: `sha256:${"a".repeat(64)}`, RELEASE_SOURCE: "a".repeat(40),
  AZURE_SUBSCRIPTION_ID: "11111111-1111-1111-1111-111111111111", AZURE_TENANT_ID: "22222222-2222-2222-2222-222222222222",
  AZURE_RESOURCE_GROUP: "example-rg", AZURE_CONTAINER_APP: "example-app",
});
const result: AzureMaintenanceResult = {
  action: "health", revision: "example-app--release", image: configuration.candidate.image,
  container: "app", replica: "example-app--release-replica", sourceCommit: configuration.candidate.sourceCommit, health: "ok",
};

test("release environment rejects ambient targets, mutable tags and untrusted registry strings", () => {
  assert.throws(() => deploymentConfiguration({}), /invalid_environment/);
  assert.throws(() => deploymentConfiguration({ AZURE_REGISTRY_NAME: "example;bad" }), /invalid_environment/);
  assert.equal(configuration.target.subscription, "11111111-1111-1111-1111-111111111111");
  assert.match(configuration.candidate.image, /^exampleacr.azurecr.io\/voice-action-lab@sha256:/);
});

test("health retries only known transient states with a six-minute budget", async () => {
  let now = 0;
  let attempts = 0;
  const codes: string[] = [];
  const operations = releaseOperations(configuration, {
    maintenance: async (options, overrides) => {
      assert.equal(options.expectedImage, configuration.candidate.image);
      assert.equal(options.expectedSourceCommit, configuration.candidate.sourceCommit);
      assert.ok(overrides?.deadline);
      attempts++;
      throw new AzureMaintenanceError("image_mismatch");
    },
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; }, progress: (code) => { codes.push(code); },
  });
  await assert.rejects(operations.waitHealthy(configuration.candidate), /health_deadline/);
  assert.equal(now, 360_000);
  assert.equal(attempts, 36);
  assert.equal(codes.length, 36);
});

test("wrong source, authentication failure and malformed proof are not retried", async () => {
  for (const code of ["source_commit_mismatch", "authentication_failed", "exec_invalid_output"] as const) {
    let attempts = 0;
    const operations = releaseOperations(configuration, {
      maintenance: async () => { attempts++; throw new AzureMaintenanceError(code); },
      sleep: async () => { assert.fail("fatal errors must not be retried"); },
    });
    await assert.rejects(operations.waitHealthy(configuration.candidate), (error) => error instanceof AzureMaintenanceError && error.code === code);
    assert.equal(attempts, 1);
  }
});

test("drain and resume pin both revision and image and reject contradictory acknowledgements", async () => {
  const calls: AzureMaintenanceOptions[] = [];
  const operations = releaseOperations(configuration, {
    maintenance: async (options) => {
      calls.push(options);
      return { ...result, action: options.action, state: { draining: false, active: false } };
    },
  });
  await assert.rejects(operations.drain(result), /invalid_release/);
  await operations.resume(result);
  for (const options of calls) {
    assert.equal(options.revision, result.revision);
    assert.equal(options.expectedImage, result.image);
  }
});

test("healthy results and image updates use only explicit configured targets", async () => {
  const operations = releaseOperations(configuration, {
    maintenance: async () => result,
    update: async (target, image) => {
      assert.deepEqual(target, configuration.target);
      assert.equal(image, configuration.candidate.image);
    },
  });
  assert.deepEqual(await operations.waitHealthy(configuration.candidate), {
    revision: result.revision, image: result.image, sourceCommit: result.sourceCommit,
  });
  await operations.update(configuration.candidate.image);
});
