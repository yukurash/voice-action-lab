import { command, isMain, runCli } from "./cli.ts";

const rootFiles = new Set([
  ".gitattributes", ".gitignore", ".nvmrc", ".dockerignore",
  "README.md", "LICENSE", "AGENTS.md", "package.json", "package-lock.json",
  "tsconfig.json", "eslint.config.js", "Dockerfile",
]);
const sourceRoots = new Set([
  ".github", "apps", "packages", "infra", "scripts", "tests",
]);
const privateSegments = new Set([
  "article", "articles", "drafts", "assets", "audio", "runs", "recordings",
  "transcripts", "local-config", "node_modules", "dist", "coverage",
  "playwright-report", "test-results",
]);

export function pathViolation(input: string): string | undefined {
  const path = input.replaceAll("\\", "/");
  const segments = path.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..") ||
      /^[a-z]:/i.test(path)) {
    return "non-canonical repository path";
  }
  if (segments.some((part) => privateSegments.has(part.toLowerCase()))) {
    return "private artifact or generated directory";
  }
  const basename = segments.at(-1) ?? "";
  if (/^\.env(?:\.|$)/i.test(basename) && basename !== ".env.example") {
    return "environment file";
  }
  if (/\.(?:wav|mp3|mp4|webm|csv|jsonl|pem|key|pfx|p12|log|local)$/i.test(path)) {
    return "private, secret, or experiment artifact extension";
  }
  if (rootFiles.has(path)) return undefined;
  if (segments.length > 1 && sourceRoots.has(segments[0] ?? "")) return undefined;
  return "path is not on the public-source allowlist";
}

export function hasSecretSignature(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(text) ||
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/.test(text) ||
    /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/.test(text);
}

export function verifyPublicIndex(): void {
  const entries = command("git", ["ls-files", "--stage", "-z"]).split("\0");
  const violations: string[] = [];
  let count = 0;
  for (const entry of entries) {
    if (!entry) continue;
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Cannot parse the Git index.");
    const [, mode, objectId, stage, path] = match;
    if (!path || !objectId) throw new Error("Incomplete Git index entry.");
    count++;
    const violation = pathViolation(path);
    if (violation) violations.push(`${path}: ${violation}`);
    if (mode !== "100644" && mode !== "100755") {
      violations.push(`${path}: symlinks and submodules are not allowed`);
    }
    if (stage !== "0") violations.push(`${path}: unresolved merge entry`);
    if (mode === "100644" || mode === "100755") {
      const content = command("git", ["cat-file", "blob", objectId]);
      if (hasSecretSignature(content)) {
        violations.push(`${path}: credential signature detected (value redacted)`);
      }
    }
  }
  if (violations.length) {
    throw new Error(`Public-source validation failed:\n${violations.join("\n")}`);
  }
  console.log(`Public-source validation passed for ${count} indexed files.`);
}

if (isMain(import.meta.url)) runCli(verifyPublicIndex);
