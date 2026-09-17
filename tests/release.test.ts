import assert from "node:assert/strict";
import test from "node:test";
import { deployRelease, ReleaseError } from "../packages/deployment/release.ts";
import type { HealthyRelease, ReleaseOperations, ReleaseTarget } from "../packages/deployment/release.ts";

const old: HealthyRelease = { revision: "app--old", image: `registry.example/lab@sha256:${"a".repeat(64)}`, sourceCommit: "a".repeat(40) };
const next: HealthyRelease = { revision: "app--new", image: `registry.example/lab@sha256:${"b".repeat(64)}`, sourceCommit: "b".repeat(40) };
const matches = (code: string) => (error: unknown) => error instanceof ReleaseError && error.code === code;

function fixture() {
  const calls: string[] = [];
  const operations: ReleaseOperations = {
    currentHealth: async () => { calls.push("current-health"); return old; },
    status: async () => { calls.push("status"); return next; },
    drain: async (target) => { calls.push(`drain:${target.revision}`); },
    update: async (image) => { calls.push(image === next.image ? "update:new" : "update:old"); },
    waitHealthy: async (candidate) => {
      calls.push(candidate.image === next.image ? "health:new" : "health:old");
      return candidate.image === next.image ? next : old;
    },
    resume: async (target) => { calls.push(`resume:${target.revision}`); },
  };
  return { calls, operations };
}

test("a release drains the pinned old revision, verifies new source, then resumes", async () => {
  const f = fixture();
  assert.deepEqual(await deployRelease(next, f.operations), next);
  assert.deepEqual(f.calls, ["current-health", "drain:app--old", "update:new", "health:new", "resume:app--new"]);
});

test("invalid image/source or a different previous repository never changes admission", async () => {
  const f = fixture();
  await assert.rejects(deployRelease({ ...next, image: "registry.example/lab:latest" }, f.operations), matches("invalid_release"));
  await assert.rejects(deployRelease({ ...next, sourceCommit: "short" }, f.operations), matches("invalid_release"));
  assert.deepEqual(f.calls, []);
  f.operations.currentHealth = async () => ({ ...old, image: `different.example/lab@sha256:${"a".repeat(64)}` });
  await assert.rejects(deployRelease(next, f.operations), matches("invalid_release"));
  assert.deepEqual(f.calls, []);
});

test("uncertain initial drain never triggers update, rollback or automatic resume", async () => {
  const f = fixture();
  f.operations.drain = async () => { throw new Error("uncertain drain"); };
  await assert.rejects(deployRelease(next, f.operations), /uncertain drain/);
  assert.deepEqual(f.calls, ["current-health"]);
});

test("failed verification drains potentially active new work before rolling back", async () => {
  const f = fixture();
  const originalHealth = f.operations.waitHealthy;
  f.operations.waitHealthy = async (candidate) => {
    if (candidate.image === next.image) throw new Error("private upstream failure");
    return originalHealth(candidate);
  };
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  f.operations.drain = async (target: ReleaseTarget) => {
    f.calls.push(`drain:${target.revision}`);
    if (target.revision === next.revision) { entered?.(); await held; }
  };
  const finished = deployRelease(next, f.operations);
  const rejected = assert.rejects(finished, matches("release_failed_rolled_back"));
  await waiting;
  assert.ok(!f.calls.includes("update:old"));
  release?.();
  await rejected;
  assert.deepEqual(f.calls, ["current-health", "drain:app--old", "update:new", "status", "drain:app--new", "update:old", "health:old", "resume:app--old"]);
});

test("an ambiguous update result is reconciled by a pinned drain and restoring the old image", async () => {
  const f = fixture();
  f.operations.update = async (image) => {
    f.calls.push(image === next.image ? "update:new" : "update:old");
    if (image === next.image) throw new Error("update timed out");
  };
  await assert.rejects(deployRelease(next, f.operations), matches("release_failed_rolled_back"));
  assert.ok(f.calls.indexOf("drain:app--new") < f.calls.indexOf("update:old"));
});

test("a foreign concurrent image is not overwritten by rollback", async () => {
  const f = fixture();
  f.operations.waitHealthy = async () => { throw new Error("not ready"); };
  f.operations.status = async () => ({ ...next, image: `registry.example/lab@sha256:${"c".repeat(64)}` });
  await assert.rejects(deployRelease(next, f.operations), matches("rollback_foreign_image"));
  assert.deepEqual(f.calls, ["current-health", "drain:app--old", "update:new"]);
});

test("failed recovery never reports success or resumes an unverified revision", async () => {
  const f = fixture();
  f.operations.waitHealthy = async () => { throw new Error("unhealthy"); };
  await assert.rejects(deployRelease(next, f.operations), matches("rollback_failed"));
  assert.ok(!f.calls.some((call) => call.startsWith("resume:")));
});

test("mismatched healthy source is a release failure, not a successful deployment", async () => {
  const f = fixture();
  f.operations.waitHealthy = async (candidate) => candidate.image === next.image ? { ...next, sourceCommit: old.sourceCommit } : old;
  await assert.rejects(deployRelease(next, f.operations), matches("release_failed_rolled_back"));
  assert.ok(!f.calls.includes("resume:app--new"));
});
