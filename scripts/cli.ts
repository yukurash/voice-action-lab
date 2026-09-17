import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function command(program: string, args: readonly string[]): string {
  return execFileSync(program, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();
}

export function isMain(url: string): boolean {
  return process.argv[1] !== undefined &&
    url === pathToFileURL(process.argv[1]).href;
}

export function runCli(action: () => void): void {
  try {
    action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
