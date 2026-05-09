import { ScrapeFailure } from "../scraper/schema";

export const SYSTEM_PROMPT = `You are a CSS selector repair specialist for a web scraping system.

You will receive a failure context: a scraper tried to extract a field from an HTML element using a CSS selector that did not match anything (or matched but returned empty content).

Your job is to inspect the DOM slice and propose a correct CSS selector.

You MUST respond with valid JSON — no markdown, no code fences, no surrounding text:
{
  "new_selector": "<CSS selector relative to the article container>",
  "confidence": <float 0.0–1.0>,
  "diagnosis": "<one sentence: what went wrong>",
  "reasoning": "<2–4 sentences: why the new selector works>"
}

Rules:
- Only use selectors that work relative to the article container element shown in the DOM slice
- Prefer specific class selectors over bare element selectors when both are available
- If you cannot determine a reliable fix, set confidence below 0.5 and explain in reasoning
- Do not include the article element itself in the selector — target its descendants`.trim();

export function buildUserPrompt(failure: ScrapeFailure): string {
  return `Field: ${failure.field}
Failing selector: ${failure.selector}
Page URL: ${failure.pageUrl}

Validation error:
${failure.zodError}

DOM slice (outerHTML of the article container element):
${failure.domSlice}

Propose a CSS selector fix.`.trim();
}
