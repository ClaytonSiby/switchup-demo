import { Langfuse } from "langfuse";
import { ScrapeFailure } from "../scraper/schema";
import { HealProposal } from "../healer/heal";

export function createLangfuseClient(): Langfuse {
  return new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    baseUrl:   process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  });
}

export function startScrapeTrace(lf: Langfuse, pageUrl: string, broken: boolean) {
  const trace = lf.trace({
    name:     "scrape-run",
    metadata: { pageUrl, brokenSelectors: broken },
    tags:     [broken ? "demo" : "production"],
  });

  const scrapeSpan = trace.span({
    name:  "playwright-scrape",
    input: { pageUrl },
  });

  return { trace, scrapeSpan };
}

export function endScrapeSpan(
  scrapeSpan: ReturnType<ReturnType<Langfuse["trace"]>["span"]>,
  booksScraped: number,
  failureCount: number,
) {
  scrapeSpan.end({
    output: { booksScraped, failureCount },
  });
}

export function traceHealGeneration(
  trace: ReturnType<Langfuse["trace"]>,
  failure: ScrapeFailure,
  proposal: HealProposal,
  systemPrompt: string,
  userPrompt: string,
  rawResponse: string,
  latencyMs: number,
  inputTokens: number,
  outputTokens: number,
) {
  trace.generation({
    name:       "gemini-heal",
    model:      "llama-3.3-70b-versatile",
    startTime:  new Date(Date.now() - latencyMs),
    endTime:    new Date(),
    input:      [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userPrompt },
    ],
    output:     rawResponse,
    usage: {
      input:  inputTokens,
      output: outputTokens,
      unit:   "TOKENS",
    },
    metadata: {
      field:      failure.field,
      oldSelector: failure.selector,
      newSelector: proposal.new_selector,
      confidence:  proposal.confidence,
    },
  });
}

export async function flushLangfuse(lf: Langfuse): Promise<void> {
  await lf.flushAsync();
}
