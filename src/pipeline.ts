import "dotenv/config";
import { chromium } from "playwright";
import Groq from "groq-sdk";
import { Provider } from "./config/providers";
import { FieldType } from "./scraper/scrape";
import { scrapeItems } from "./scraper/scrape";
import { ScrapeFailure } from "./scraper/schema";
import { healSelector, HealProposal } from "./healer/heal";
import { SYSTEM_PROMPT, buildUserPrompt } from "./healer/prompt";
import { generatePatch } from "./diff/patch";
import { appendRunHistory, RunHistoryEntry, RunProposal } from "./config/run-history";
import {
  createLangfuseClient,
  startScrapeTrace,
  endScrapeSpan,
  traceHealGeneration,
  flushLangfuse,
} from "./observability/langfuse";

export type PipelineEvent =
  | { type: "log"; source: string; message: string; warn?: boolean }
  | { type: "scrape:done"; bookCount: number; failureCount: number; articleCount: number }
  | { type: "failure"; field: string; selector: string; error: string; totalFailures: number }
  | { type: "proposal"; field: string; proposal: HealProposal; latencyMs: number; inputTokens: number; outputTokens: number }
  | { type: "sandbox-result"; validCount: number; totalCount: number }
  | { type: "patch"; patchContent: string; outputPath: string; field: string; oldSelector: string; newSelector: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type Emit = (event: PipelineEvent) => void;

export interface PipelineOptions {
  provider:  Provider;
  demo:      boolean;
  maxItems:  number;
  outputDir: string;
}

export async function runPipeline(opts: PipelineOptions, emit: Emit): Promise<void> {
  const { provider, demo } = opts;

  // Build active selectors: start from provider fields, then overlay demoBreaks if demo mode
  const activeSelectors: Record<string, string> = {};
  const fieldTypes: Record<string, FieldType> = {};
  for (const f of provider.fields) {
    activeSelectors[f.name] = f.selector;
    fieldTypes[f.name] = f.type;
  }
  if (demo) {
    for (const b of provider.demoBreaks) {
      activeSelectors[b.field] = b.selector;
    }
  }

  const baseUrl = provider.baseUrl ?? provider.url;
  const lf      = createLangfuseClient();
  const groq    = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const browser = await chromium.launch({ headless: true });
  const { trace, scrapeSpan } = startScrapeTrace(lf, provider.url, demo);

  const runProposals: RunProposal[] = [];

  try {
    emit({ type: "log", source: "scraper", message: `Scraping ${provider.url}` });
    const { items, failures, articleCount } = await scrapeItems(
      browser,
      activeSelectors,
      fieldTypes,
      provider.articleSelector,
      opts.maxItems,
      provider.url,
      baseUrl,
    );

    emit({ type: "log", source: "scraper", message: `Found ${articleCount} articles — ${items.length} valid, ${failures.length} failures` });
    emit({ type: "scrape:done", bookCount: items.length, failureCount: failures.length, articleCount });
    endScrapeSpan(scrapeSpan, items.length, failures.length);

    if (failures.length === 0) {
      emit({ type: "log", source: "scraper", message: "No failures — healer not needed" });
      emit({ type: "done" });
      appendRunHistory(opts.outputDir, buildHistoryEntry(opts, items.length, 0, failures.length, runProposals));
      return;
    }

    const seenFields = new Set<string>();
    const uniqueFailures: ScrapeFailure[] = [];
    for (const f of failures) {
      if (!seenFields.has(f.field)) { seenFields.add(f.field); uniqueFailures.push(f); }
    }

    for (const failure of uniqueFailures) {
      const firstError = (() => {
        try { return (JSON.parse(failure.zodError) as Array<{ message: string }>)[0]?.message ?? "selector returned empty"; }
        catch { return "selector returned empty"; }
      })();

      emit({ type: "log", source: "scraper", message: `Field "${failure.field}": selector "${failure.selector}" matched nothing` });
      emit({ type: "failure", field: failure.field, selector: failure.selector, error: firstError, totalFailures: failures.length });

      emit({ type: "log", source: "healer", message: "Calling Groq llama-3.3-70b-versatile..." });
      const startMs  = Date.now();
      const result   = await healSelector(groq, failure);
      const latencyMs = Date.now() - startMs;

      const { proposal, inputTokens, outputTokens } = result;

      emit({ type: "log", source: "healer", message: `Proposal: "${proposal.new_selector}" (confidence: ${proposal.confidence.toFixed(2)})` });
      emit({ type: "log", source: "healer", message: `Diagnosis: ${proposal.diagnosis}` });
      emit({ type: "log", source: "healer", message: `Latency: ${latencyMs}ms | Tokens: ${inputTokens}in / ${outputTokens}out` });

      if (proposal.confidence < 0.5) {
        emit({ type: "log", source: "healer", message: "Low confidence — patch generated for human review", warn: true });
      }

      emit({ type: "proposal", field: failure.field, proposal, latencyMs, inputTokens, outputTokens });

      emit({ type: "log", source: "sandbox", message: `Retrying with "${proposal.new_selector}"...` });
      const patchedSelectors = { ...activeSelectors, [failure.field]: proposal.new_selector };
      const { items: retryItems } = await scrapeItems(
        browser, patchedSelectors, fieldTypes, provider.articleSelector, opts.maxItems, provider.url, baseUrl,
      );
      emit({ type: "log", source: "sandbox", message: `${retryItems.length}/${opts.maxItems} items valid with proposed selector` });
      emit({ type: "sandbox-result", validCount: retryItems.length, totalCount: opts.maxItems });

      const patch = await generatePatch(provider, failure.field, proposal, opts.outputDir, retryItems.length);
      const patchFileName = `${provider.id}-selectors.patch`;
      emit({ type: "log", source: "diff", message: `Patch written → apply with: git apply output/${patchFileName}` });
      emit({
        type:        "patch",
        patchContent: patch.patchContent,
        outputPath:   patch.outputPath,
        field:        failure.field,
        oldSelector:  activeSelectors[failure.field],
        newSelector:  proposal.new_selector,
      });

      runProposals.push({
        field:       failure.field,
        oldSelector: activeSelectors[failure.field],
        newSelector: proposal.new_selector,
        confidence:  proposal.confidence,
      });

      traceHealGeneration(
        trace, failure, proposal, SYSTEM_PROMPT, buildUserPrompt(failure),
        result.rawResponse, latencyMs, inputTokens, outputTokens,
      );
    }

    emit({ type: "log", source: "langfuse", message: "Flushing events to Langfuse..." });
    emit({ type: "done" });
    appendRunHistory(opts.outputDir, buildHistoryEntry(opts, items.length, uniqueFailures.length, failures.length, runProposals));
  } catch (err) {
    emit({ type: "error", message: String(err) });
  } finally {
    await browser.close();
    await flushLangfuse(lf);
  }
}

function buildHistoryEntry(
  opts:       PipelineOptions,
  valid:      number,
  healed:     number,
  failures:   number,
  proposals:  RunProposal[],
): RunHistoryEntry {
  return {
    id:           `run-${Date.now()}`,
    timestamp:    new Date().toISOString(),
    providerId:   opts.provider.id,
    providerName: opts.provider.name,
    mode:         opts.demo ? "demo" : "live",
    summary:      { scraped: valid + failures, valid, failures: healed },
    proposals,
  };
}
