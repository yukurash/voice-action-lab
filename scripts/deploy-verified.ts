import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AzureMaintenanceError, parseAzureMaintenanceArgs, runAzureMaintenance } from "./maintenance-azure.ts";
import type { AzureMaintenanceOptions, AzureMaintenanceResult } from "./maintenance-azure.ts";
import { isSourceCommit } from "../packages/deployment/health.ts";
import { deployRelease, ReleaseError } from "../packages/deployment/release.ts";
import type { HealthyRelease, ReleaseCandidate, ReleaseOperations, ReleaseTarget } from "../packages/deployment/release.ts";

export class DeploymentAdapterError extends Error {
  readonly code: "invalid_environment" | "ubuntu_workflow_required" | "image_update_failed" | "health_deadline" | "invalid_health_result";

  constructor(code: DeploymentAdapterError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface DeploymentConfiguration {
  target: AzureMaintenanceOptions;
  candidate: ReleaseCandidate;
}

export function deploymentConfiguration(environment: Readonly<Record<string, string | undefined>>): DeploymentConfiguration {
  const registry = environment.AZURE_REGISTRY_NAME ?? "";
  const digest = environment.RELEASE_DIGEST ?? "";
  const source = environment.RELEASE_SOURCE ?? "";
  if (!/^[a-z0-9]{5,50}$/u.test(registry) || !/^sha256:[a-f0-9]{64}$/u.test(digest) || !isSourceCommit(source)) {
    throw new DeploymentAdapterError("invalid_environment");
  }
  const target = parseAzureMaintenanceArgs([
    "status", "--subscription", environment.AZURE_SUBSCRIPTION_ID ?? "",
    "--tenant", environment.AZURE_TENANT_ID ?? "",
    "--resource-group", environment.AZURE_RESOURCE_GROUP ?? "",
    "--app", environment.AZURE_CONTAINER_APP ?? "",
  ]);
  return { target, candidate: { image: `${registry}.azurecr.io/voice-action-lab@${digest}`, sourceCommit: source.toLowerCase() } };
}

function updateImage(target: AzureMaintenanceOptions, image: string): Promise<void> {
  if (process.platform !== "linux") throw new DeploymentAdapterError("ubuntu_workflow_required");
  return new Promise((resolve, reject) => {
    execFile("az", [
      "containerapp", "update", "--subscription", target.subscription,
      "--resource-group", target.resourceGroup, "--name", target.app,
      "--image", image, "--no-wait", "--output", "none", "--only-show-errors",
    ], { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) => {
      if (error) reject(new DeploymentAdapterError("image_update_failed"));
      else resolve();
    });
  });
}

export interface DeploymentDependencies {
  maintenance: typeof runAzureMaintenance;
  update: (target: AzureMaintenanceOptions, image: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  progress: (code: string) => void;
}

function healthy(result: AzureMaintenanceResult): HealthyRelease {
  if (result.health !== "ok" || !isSourceCommit(result.sourceCommit)) throw new DeploymentAdapterError("invalid_health_result");
  return { revision: result.revision, image: result.image, sourceCommit: result.sourceCommit };
}

const retryableHealthCodes = new Set([
  "image_mismatch", "revision_mismatch", "replica_count", "replica_not_ready",
  "arm_timeout", "arm_request_failed", "exec_handshake_failed", "exec_transport_failed", "exec_close_timeout",
]);

export function releaseOperations(configuration: DeploymentConfiguration, overrides: Partial<DeploymentDependencies> = {}): ReleaseOperations {
  const dependencies: DeploymentDependencies = {
    maintenance: runAzureMaintenance, update: updateImage, now: () => performance.now(),
    sleep: async (milliseconds) => { await delay(milliseconds); },
    progress: (code) => { console.error(JSON.stringify({ event: "waiting_for_healthy_revision", code })); },
    ...overrides,
  };
  const target = configuration.target;
  const pinned = (selected: ReleaseTarget) => ({ revision: selected.revision, expectedImage: selected.image });
  return {
    currentHealth: async () => healthy(await dependencies.maintenance({ ...target, action: "health" })),
    status: async () => {
      const result = await dependencies.maintenance({ ...target, action: "status" });
      return { revision: result.revision, image: result.image };
    },
    drain: async (selected) => {
      const result = await dependencies.maintenance({ ...target, action: "drain", ...pinned(selected) });
      if (result.state?.draining !== true || result.state.active !== false) throw new ReleaseError("invalid_release");
    },
    update: async (image) => { await dependencies.update(target, image); },
    waitHealthy: async (candidate) => {
      const deadline = dependencies.now() + 360_000;
      while (dependencies.now() < deadline) {
        try {
          return healthy(await dependencies.maintenance({
            ...target, action: "health", expectedImage: candidate.image, expectedSourceCommit: candidate.sourceCommit,
          }, { deadline: (milliseconds) => AbortSignal.timeout(Math.max(1, Math.min(milliseconds, Math.floor(deadline - dependencies.now())))) }));
        } catch (error) {
          if (dependencies.now() >= deadline) break;
          if (!(error instanceof AzureMaintenanceError) || !retryableHealthCodes.has(error.code)) throw error;
          dependencies.progress(error.code);
          await dependencies.sleep(Math.min(10_000, Math.max(0, deadline - dependencies.now())));
        }
      }
      throw new DeploymentAdapterError("health_deadline");
    },
    resume: async (selected) => {
      const result = await dependencies.maintenance({ ...target, action: "resume", ...pinned(selected) });
      if (result.state?.draining !== false) throw new ReleaseError("invalid_release");
    },
  };
}

export async function runDeploymentCli(
  argv: readonly string[], environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    if (argv.length) throw new DeploymentAdapterError("invalid_environment");
    if (process.platform !== "linux") throw new DeploymentAdapterError("ubuntu_workflow_required");
    const configuration = deploymentConfiguration(environment);
    console.log(JSON.stringify(await deployRelease(configuration.candidate, releaseOperations(configuration))));
    return 0;
  } catch (error) {
    const code = error instanceof ReleaseError || error instanceof AzureMaintenanceError || error instanceof DeploymentAdapterError
      ? error.code : "deployment_failed";
    console.error(JSON.stringify({ error: code, ...(error instanceof ReleaseError && error.phase ? { phase: error.phase } : {}) }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runDeploymentCli(process.argv.slice(2));
