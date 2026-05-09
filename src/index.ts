import "dotenv/config";
import * as path from "path";
import { runPipeline, PipelineEvent } from "./pipeline";
import { loadProviders } from "./config/providers";

const IS_DEMO = process.argv.includes("--demo") || process.env.BROKEN_SELECTORS === "true";

function cliEmit(evt: PipelineEvent): void {
  switch (evt.type) {
    case "log":
      if (evt.warn) console.warn(`[${evt.source}] ${evt.message}`);
      else console.log(`[${evt.source}] ${evt.message}`);
      break;
    case "scrape:done":
      console.log(`[scraper] ${evt.bookCount} valid items, ${evt.failureCount} failures`);
      break;
    case "failure":
      console.log(`\n[healer] ${evt.totalFailures} failures detected on field: ${evt.field}`);
      break;
    case "proposal":
      console.log(`[healer] Reasoning: ${evt.proposal.reasoning}`);
      break;
    case "sandbox-result":
      break;
    case "patch":
      console.log(`\n[diff] Patch written to: ${evt.outputPath}`);
      console.log(`[diff] Apply with: git apply ${evt.outputPath}`);
      if (IS_DEMO) {
        console.log("\n--- Patch Preview ---");
        console.log(evt.patchContent);
      }
      break;
    case "done":
      console.log("[langfuse] Events flushed");
      break;
    case "error":
      console.error("[fatal]", evt.message);
      process.exit(1);
  }
}

(async () => {
  const providers = await loadProviders();
  if (providers.length === 0) {
    console.error("[fatal] No providers found in the database. Run npm run db:migrate to seed.");
    process.exit(1);
  }
  const provider = providers[0];

  console.log(`[demo] Starting self-healing scraper — provider: ${provider.name}, demo: ${IS_DEMO}`);

  await runPipeline(
    {
      provider,
      demo:      IS_DEMO,
      maxItems:  parseInt(process.env.MAX_BOOKS ?? "20", 10),
      outputDir: path.join(__dirname, "..", "output"),
    },
    cliEmit,
  );
})().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
