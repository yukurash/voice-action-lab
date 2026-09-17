import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function absolutePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    throw new TypeError("Output and repository paths must be nonempty absolute paths.");
  }
  if (process.platform === "win32") {
    const windowsPath = value.replaceAll("/", "\\");
    if (/^\\\\[?.]\\/u.test(windowsPath) || windowsPath.startsWith("\\") && !windowsPath.startsWith("\\\\")) {
      throw new Error("Device-namespace and drive-relative paths are not supported.");
    }
    const withoutDrive = windowsPath.replace(/^[a-zA-Z]:/u, "");
    if (withoutDrive.includes(":")) throw new Error("Alternate data stream paths are not supported.");
  }
  return resolve(value);
}

function isWithin(parent: string, child: string): boolean {
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const delta = relative(fold(parent), fold(child));
  return delta === "" || delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta);
}

/**
 * Returns a canonical external path without creating anything. Checks every
 * ancestor, including aliases into the repository and dangling symlinks.
 * Use the returned path; revalidate before writing if filesystem links can change.
 * This is a path guard, not an atomic lock against concurrent filesystem mutation.
 */
export async function resolveExternalOutputPath(outputPath: string, repositoryRoot: string): Promise<string> {
  const repository = absolutePath(repositoryRoot);
  const candidate = absolutePath(outputPath);
  const physicalRepository = await realpath(repository);
  if (!(await stat(physicalRepository)).isDirectory()) throw new Error("Repository root must be a directory.");
  const rejectInternal = (path: string) => {
    if (isWithin(repository, path) || isWithin(physicalRepository, path)) {
      throw new Error("Experiment output must be outside the public repository.");
    }
  };
  rejectInternal(candidate);
  let cursor = candidate;
  let canonical: string | undefined;
  const missing: string[] = [];
  for (;;) {
    rejectInternal(cursor);
    let physical: string | undefined;
    try {
      physical = await realpath(cursor);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      let exists = false;
      try {
        await lstat(cursor);
        exists = true;
      } catch (inspectionError: unknown) {
        if (!isMissing(inspectionError)) throw inspectionError;
      }
      if (exists) throw new Error("Cannot safely resolve output through a dangling symlink.", { cause: error });
    }
    if (physical !== undefined) {
      rejectInternal(physical);
      if (canonical === undefined && missing.length > 0 && !(await stat(physical)).isDirectory()) {
        throw new Error("Output ancestor must be a directory.");
      }
      canonical ??= resolve(physical, ...missing);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    if (canonical === undefined) missing.unshift(basename(cursor));
    cursor = parent;
  }
  if (canonical === undefined) throw new Error("Output has no resolvable existing ancestor.");
  rejectInternal(canonical);
  return canonical;
}
