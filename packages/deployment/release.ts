import { isSourceCommit } from "./health.ts";

export interface ReleaseTarget { revision: string; image: string }
export interface HealthyRelease extends ReleaseTarget { sourceCommit: string }
export interface ReleaseCandidate { image: string; sourceCommit: string }
export type ReleasePhase = "update" | "verify" | "resume";

export interface ReleaseOperations {
  currentHealth(): Promise<HealthyRelease>;
  status(): Promise<ReleaseTarget>;
  drain(target: ReleaseTarget): Promise<void>;
  update(image: string): Promise<void>;
  waitHealthy(candidate: ReleaseCandidate): Promise<HealthyRelease>;
  resume(target: ReleaseTarget): Promise<void>;
}

export class ReleaseError extends Error {
  readonly code: "invalid_release" | "release_failed_rolled_back" | "rollback_failed" | "rollback_foreign_image";
  readonly phase?: ReleasePhase;

  constructor(code: ReleaseError["code"], phase?: ReleasePhase) {
    super(code);
    this.code = code;
    if (phase !== undefined) this.phase = phase;
  }
}

function imageRepository(image: string): string {
  const match = /^([a-z0-9][a-z0-9./_-]+)@sha256:[a-f0-9]{64}$/u.exec(image);
  if (!match?.[1]) throw new ReleaseError("invalid_release");
  return match[1];
}

export async function deployRelease(candidate: ReleaseCandidate, operations: ReleaseOperations): Promise<HealthyRelease> {
  const repository = imageRepository(candidate.image);
  if (!isSourceCommit(candidate.sourceCommit)) throw new ReleaseError("invalid_release");
  const previous = await operations.currentHealth();
  if (imageRepository(previous.image) !== repository || !isSourceCommit(previous.sourceCommit)) {
    throw new ReleaseError("invalid_release");
  }
  // A failed initial drain stays blocked for explicit recovery; do not silently reopen admission.
  await operations.drain(previous);
  let phase: ReleasePhase = "update";
  try {
    await operations.update(candidate.image);
    phase = "verify";
    const healthy = await operations.waitHealthy(candidate);
    if (healthy.image !== candidate.image || healthy.sourceCommit !== candidate.sourceCommit) {
      throw new ReleaseError("invalid_release");
    }
    phase = "resume";
    await operations.resume(healthy);
    return healthy;
  } catch {
    try {
      const current = await operations.status();
      if (current.image !== candidate.image && current.image !== previous.image) {
        throw new ReleaseError("rollback_foreign_image", phase);
      }
      // A new healthy revision might already have accepted work; drain it before any rollback.
      await operations.drain(current);
      await operations.update(previous.image);
      const restored = await operations.waitHealthy(previous);
      if (restored.image !== previous.image || restored.sourceCommit !== previous.sourceCommit) {
        throw new ReleaseError("invalid_release");
      }
      await operations.resume(restored);
    } catch (error) {
      if (error instanceof ReleaseError && error.code === "rollback_foreign_image") throw error;
      throw new ReleaseError("rollback_failed", phase);
    }
    throw new ReleaseError("release_failed_rolled_back", phase);
  }
}
