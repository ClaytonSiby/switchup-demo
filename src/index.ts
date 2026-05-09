import "dotenv/config";
import * as path from "path";
import { runPipeline, PipelineEvent } from "./pipeline";

const IS_DEMO = process.argv.includes("--demo");

function cliEmit(evt: PipelineEvent): void {
  switch (evt.type) {
    case "log":
      if (evt.warn) console.warn(`[${evt.source}] ${evt.message}`);
      else console.log(`[${evt.source}] ${evt.message}`);
      break;
    case "scrape:done":
      console.log(`[scraper] ${evt.bookCount} valid books, ${evt.failureCount} failures`);
      break;
    case "failure":
      console.log(`\n[healer] ${evt.totalFailures} failures detected on field: ${evt.field}`);
      break;
    case "proposal":
      console.log(`[healer] Reasoning: ${evt.proposal.reasoning}`);
      break;
    case "sandbox-result":
      // logged via "log" events already
      break;
    case "patch":
      console.log(`\n[diff] Patch written to: ${evt.outputPath}`);
      console.log(`[diff] Apply with: git apply output/selectors.patch`);
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

console.log(`[demo] Starting self-healing scraper (demo=${IS_DEMO})`);

runPipeline(
  {
    demo:      IS_DEMO || process.env.BROKEN_SELECTORS === "true",
    maxBooks:  parseInt(process.env.MAX_BOOKS ?? "20", 10),
    outputDir: path.join(__dirname, "..", "output"),
    targetUrl: "https://books.toscrape.com/catalogue/page-1.html",
  },
  cliEmit,
).catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
