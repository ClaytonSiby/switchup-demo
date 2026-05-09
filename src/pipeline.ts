import "dotenv/config";
import { chromium } from "playwright";
import Groq from "groq-sdk";
import { WORKING_SELECTORS, BROKEN_SELECTORS, BookField } from "./config/selectors";
import { scrapeBooks } from "./scraper/scrape";
import { BookSchema, RawBook, ScrapeFailure } from "./scraper/schema";
import { healSelector, HealProposal } from "./healer/heal";
import { SYSTEM_PROMPT, buildUserPrompt } from "./healer/prompt";
import { generatePatch } from "./diff/patch";
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
  demo:      boolean;
  maxBooks:  number;
  outputDir: string;
  targetUrl: string;
}

function transformBook(raw: RawBook): unknown {
  const priceNum = parseFloat(raw.price.replace("£", ""));
  const ratingNum = parseInt(raw.rating, 10);
  const availability = raw.availability.toLowerCase().includes("in stock")
    ? "In stock"
    : "Out of stock";
  return { ...raw, price: priceNum, rating: ratingNum, availability };
}

export async function runPipeline(opts: PipelineOptions, emit: Emit): Promise<void> {
  const activeSelectors = opts.demo ? BROKEN_SELECTORS : WORKING_SELECTORS;
  const lf     = createLangfuseClient();
  const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const browser = await chromium.launch({ headless: true });
  const { trace, scrapeSpan } = startScrapeTrace(lf, opts.targetUrl, opts.demo);

  try {
    emit({ type: "log", source: "scraper", message: `Scraping ${opts.targetUrl}` });
    const { books, failures, articleCount } = await scrapeBooks(
      browser, activeSelectors, opts.maxBooks, opts.targetUrl,
    );

    const validBooks = books
      .map((b) => BookSchema.safeParse(transformBook(b)))
      .filter((r) => r.success)
      .map((r) => r.data!);

    emit({ type: "log", source: "scraper", message: `Found ${articleCount} articles — ${validBooks.length} valid, ${failures.length} failures` });
    emit({ type: "scrape:done", bookCount: validBooks.length, failureCount: failures.length, articleCount });
    endScrapeSpan(scrapeSpan, validBooks.length, failures.length);

    if (failures.length === 0) {
      emit({ type: "log", source: "scraper", message: "No failures — healer not needed" });
      emit({ type: "done" });
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
      const startMs = Date.now();
      const result  = await healSelector(groq, failure);
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
      const patched = { ...activeSelectors, [failure.field]: proposal.new_selector };
      const { books: rb } = await scrapeBooks(browser, patched, opts.maxBooks, opts.targetUrl);
      const retryValid = rb.filter((b) => BookSchema.safeParse(transformBook(b)).success);
      emit({ type: "log", source: "sandbox", message: `${retryValid.length}/${opts.maxBooks} books valid with proposed selector` });
      emit({ type: "sandbox-result", validCount: retryValid.length, totalCount: opts.maxBooks });

      const patch = await generatePatch(
        activeSelectors, failure.field as BookField, proposal, opts.outputDir, retryValid.length,
      );
      emit({ type: "log", source: "diff", message: `Patch written → apply with: git apply output/selectors.patch` });
      emit({
        type: "patch",
        patchContent: patch.patchContent,
        outputPath:   patch.outputPath,
        field:        failure.field,
        oldSelector:  activeSelectors[failure.field as BookField],
        newSelector:  proposal.new_selector,
      });

      traceHealGeneration(
        trace, failure, proposal, SYSTEM_PROMPT, buildUserPrompt(failure),
        result.rawResponse, latencyMs, inputTokens, outputTokens,
      );
    }

    emit({ type: "log", source: "langfuse", message: "Flushing events to Langfuse..." });
    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: String(err) });
  } finally {
    await browser.close();
    await flushLangfuse(lf);
  }
}
