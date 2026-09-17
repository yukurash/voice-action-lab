import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hasSecretSignature, pathViolation } from "../scripts/check-public.ts";

test("public code, CI and placeholder configuration are allowed", () => {
  for (const path of [
    "README.md", "package-lock.json", ".github/workflows/ci.yml", "Dockerfile", ".dockerignore",
    "apps/web/src/App.tsx", "infra/main.bicep", "apps/server/.env.example",
  ]) assert.equal(pathViolation(path), undefined, path);
});

test("private files are rejected at any depth and with Windows separators", () => {
  for (const path of [
    "article/post.md", "scripts/articles/post.md", "runs/result.json",
    "apps\\web\\audio\\voice.wav", "apps/server/.env",
    "apps/server/.env.production", "tests/result.csv",
    "tests/session.jsonl", "apps/web/session.webm", "infra/server.key",
    "notes.md", "../README.md", "/README.md", "C:\\README.md",
    "apps/../README.md", "tests/Recordings/capture.json",
  ]) assert.notEqual(pathViolation(path), undefined, path);
});

test("credential signatures are detected without real credentials in fixtures", () => {
  assert.equal(hasSecretSignature("ghp_" + "a".repeat(40)), true);
  assert.equal(hasSecretSignature("github_pat_" + "a".repeat(40)), true);
  assert.equal(hasSecretSignature("-----BEGIN " + "PRIVATE KEY-----"), true);
  assert.equal(hasSecretSignature("AccountKey=" + "a".repeat(50)), true);
  assert.equal(hasSecretSignature("AZURE_CLIENT_ID=<configure-outside-repo>"), false);
});

test("validation inspects staged blobs rather than edited working files", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-action-index-test-"));
  const checker = resolve("dist/scripts/check-public.js");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    git("init", "--quiet");
    writeFileSync(join(directory, "README.md"), "ghp_" + "a".repeat(40));
    git("add", "--", "README.md");
    writeFileSync(join(directory, "README.md"), "clean working file");
    assert.throws(
      () => execFileSync(process.execPath, [checker], {
        cwd: directory, stdio: "pipe",
      }),
      /Command failed/,
    );
    git("add", "--", "README.md");
    assert.match(
      execFileSync(process.execPath, [checker], {
        cwd: directory, encoding: "utf8",
      }),
      /passed for 1 indexed files/,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
