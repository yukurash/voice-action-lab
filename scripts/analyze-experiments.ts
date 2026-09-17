import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { analyzeRecordedTrials } from "../packages/experiments/aggregation.ts";
import { ExperimentRunError, interruptedResult } from "../packages/experiments/runner-model.ts";
import { findExperimentRepository, openRunStore, writeExclusiveArtifact } from "./run-experiments.ts";

/** Read-only source records; incomplete starts become explicit failed rows in this immutable report. */
export async function analyzeExperimentDirectory(repository: string, directory: string, reportName: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}\.json$/u.test(reportName)) throw new ExperimentRunError("invalid_report_name");
  const store = await openRunStore(repository, directory);
  try {
    const manifest = await store.manifest();
    const { starts, results } = await store.records(manifest);
    for (const start of starts) {
      if (!results.some((result) => result.slotId === start.slotId)) results.push(interruptedResult(start, new Date().toISOString()));
    }
    const report = analyzeRecordedTrials(manifest, results);
    await writeExclusiveArtifact(repository, store.output, `reports/${reportName}`, report);
    return report;
  } finally { await store.close(); }
}

export async function runAnalysisCli(argv: readonly string[]): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: { repository: { type: "string" }, run: { type: "string" }, report: { type: "string" } },
    });
    if (values.repository !== undefined && !isAbsolute(values.repository) || !values.run || !isAbsolute(values.run) || !values.report) {
      throw new ExperimentRunError("invalid_arguments");
    }
    const repository = await findExperimentRepository();
    if (values.repository !== undefined && (await realpath(values.repository)).toLowerCase() !== repository.toLowerCase()) {
      throw new ExperimentRunError("repository_mismatch");
    }
    const report = await analyzeExperimentDirectory(repository, values.run, values.report);
    console.log(JSON.stringify({ formalComplete: report.formalComplete, ...report.totals }));
    return 0;
  } catch (error: unknown) {
    console.error(`experiment analysis failed: ${error instanceof ExperimentRunError ? error.code : "analysis_failed"}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runAnalysisCli(process.argv.slice(2));
