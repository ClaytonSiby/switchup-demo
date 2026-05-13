# Architecture & Flow Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Self-Healing Web Scraper                     │
│                                                                   │
│  Playwright → Zod Validate → Fail? → Groq Heal → Sandbox Test   │
│                           ↓                              ↓         │
│                       Emit Events                  Generate Patch │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Entry Points

Two interfaces into the same pipeline (`runPipeline`):

```
CLI (npm run demo/scrape)  ──┐
                              ├─→ runPipeline(opts, emit) ──→ Langfuse
Web Server (npm run serve) ──┘
  ↓
  SSE streaming to browser (public/index.html)
```

| Entry Point | File | Transport | Purpose |
|---|---|---|---|
| **CLI** | `src/index.ts` | `console.log` | Run pipeline headless, emit logs to terminal |
| **Web Server** | `src/server.ts` | Server-Sent Events (SSE) | Stream events in real-time to browser UI |

---

## Complete Pipeline Flow with Events

### Stage 1: Provider & Config Load
```
runPipeline(opts, emit)
  ├─ loadProviders()             [Neon: select from providers table]
  ├─ getProvider(id)             [Neon: select one provider]
  └─ Build activeSelectors       [overlay demoBreaks if demo=true]
```

**No events emitted** — internal setup only.

---

### Stage 2: Scrape & Validate
```
scrapeItems(browser, selectors, fieldTypes, articleSelector, maxItems, pageUrl, baseUrl)
  │
  ├─ browser.goto(pageUrl)                    [Playwright navigate]
  │
  ├─ page.locator(articleSelector)            [Playwright query articles]
  │
  ├─ for each article:
  │    └─ for each field selector:
  │         ├─ extractField(selector, type)   [text | href | class]
  │         ├─ Validate with GenericItemSchema
  │         └─ On failure: create ScrapeFailure
  │              ├─ field: name
  │              ├─ selector: CSS selector that failed
  │              ├─ domSlice: outerHTML of article element
  │              ├─ pageUrl: canonical URL
  │              ├─ zodError: stringified validation error
  │              └─ timestamp: ISO datetime
  │
  └─ Return: { items: GenericItem[], failures: ScrapeFailure[], articleCount: number }
```

**Events emitted:**

| Event | Data | Source | When |
|---|---|---|---|
| `log` | `{ source: "scraper", message: "Scraping {url}" }` | `pipeline.ts:64` | Before scrape starts |
| `scrape:done` | `{ bookCount, failureCount, articleCount }` | `pipeline.ts:76` | After scrape completes |

---

### Stage 3: Failure Deduplication
```
Deduplicate failures by field (one unique failure per field key)
  └─ for (const failure of uniqueFailures)
       └─ First failure of that field key only
```

**No events** — internal dedup.

---

### Stage 4: Healer Loop (Per Unique Failure)
```
for (const failure of uniqueFailures):
  │
  ├─ Emit failure context
  │  └─ EMIT: { type: "failure", field, selector, error, totalFailures }
  │
  ├─ healSelector(groq, failure)                [Groq API call]
  │    │
  │    ├─ buildUserPrompt(failure)              [src/healer/prompt.ts]
  │    │    └─ Includes: field name, broken selector, domSlice, error context
  │    │
  │    ├─ client.chat.completions.create({
  │    │     model: "llama-3.3-70b-versatile",
  │    │     messages: [system prompt, user prompt],
  │    │     response_format: { type: "json_object" }    [JSON mode]
  │    │  })
  │    │
  │    ├─ Parse JSON response
  │    │
  │    ├─ Validate with HealProposalSchema      [Zod]
  │    │    └─ new_selector, confidence, diagnosis, reasoning
  │    │
  │    └─ Return: { failure, proposal, rawResponse, inputTokens, outputTokens }
  │
  ├─ Emit proposal + telemetry
  │  ├─ EMIT: { type: "proposal", field, proposal, latencyMs, inputTokens, outputTokens }
  │  ├─ Warn if confidence < 0.5
  │  └─ Log: diagnosis & latency
  │
  └─ traceHealGeneration(langfuse)              [observability]
       └─ Record to Langfuse for analysis
```

**Events emitted:**

| Event | Data | Source | Condition |
|---|---|---|---|
| `failure` | `{ field, selector, error, totalFailures }` | `pipeline.ts:99` | When unique failure detected |
| `log` | `{ source: "healer", message: "Calling Groq..." }` | `pipeline.ts:101` | Before LLM call |
| `log` | `{ source: "healer", message: "Proposal: {selector}..." }` | `pipeline.ts:108` | After LLM responds |
| `log` | `{ source: "healer", message: "Latency: {ms}ms | Tokens: {in}/{out}" }` | `pipeline.ts:110` | Token usage info |
| `log` | `{ source: "healer", message: "Low confidence (0.XX)...", warn: true }` | `pipeline.ts:113` | If confidence < 0.5 |
| `proposal` | `{ field, proposal: HealProposal, latencyMs, inputTokens, outputTokens }` | `pipeline.ts:116` | Always after heal |

---

### Stage 5: Sandbox Validation
```
Retry scrape with proposed selector (same browser, same page)
  │
  ├─ patchedSelectors = { ...activeSelectors, [field]: proposal.new_selector }
  │
  ├─ scrapeItems(browser, patchedSelectors, ...)    [Real browser, real page]
  │    └─ Returns: { items: retryItems, failures, ... }
  │
  ├─ Emit sandbox score
  │  ├─ EMIT: { type: "sandbox-result", validCount: retryItems.length, totalCount: maxItems }
  │  └─ Log: "{validCount}/{totalCount} items valid with proposed selector"
  │
  └─ Decision: proceed to patch regardless of score
       [Score is informational for human review, not a gate]
```

**Events emitted:**

| Event | Data | Source | When |
|---|---|---|---|
| `log` | `{ source: "sandbox", message: "Retrying with '{selector}'..." }` | `pipeline.ts:118` | Sandbox starts |
| `log` | `{ source: "sandbox", message: "{N}/{max} items valid..." }` | `pipeline.ts:123` | Sandbox completes |
| `sandbox-result` | `{ validCount, totalCount }` | `pipeline.ts:124` | Pass/fail count |

---

### Stage 6: Patch Generation & Emit
```
generatePatch(provider, field, proposal, outputDir, testedItems)
  │
  ├─ Load provider field definition
  │
  ├─ Read selectors.ts as raw source text
  │
  ├─ String-replace: old selector → new selector
  │
  ├─ Generate unified diff
  │    └─ createTwoFilesPatch(
  │         oldContent, newContent,
  │         filename, filename,
  │         header, header
  │       )
  │
  ├─ Write to: output/{providerId}-selectors.patch
  │
  ├─ Build summary metadata:
  │    └─ { field, oldSelector, newSelector, confidence, testedItems }
  │
  └─ Return: { patchContent, outputPath, summary }
```

**Events emitted:**

| Event | Data | Source | When |
|---|---|---|---|
| `log` | `{ source: "diff", message: "Patch written → apply with: git apply output/..." }` | `pipeline.ts:128` | Patch created |
| `patch` | `{ patchContent, outputPath, field, oldSelector, newSelector }` | `pipeline.ts:129-136` | Display to user/browser |

---

### Stage 7: Observability & Flush
```
Record to Langfuse + append run history
  │
  ├─ traceHealGeneration(trace, failure, proposal, prompts, response, latency, tokens)
  │    └─ Record: input, output, confidence, latency, token usage for each fix
  │
  ├─ appendRunHistory(outputDir, buildHistoryEntry(...))
  │    └─ Write run metadata to JSON for audit trail
  │
  └─ flushLangfuse(client)
       └─ Block until all events sent to cloud
```

**Events emitted:**

| Event | Data | Source | When |
|---|---|---|---|
| `log` | `{ source: "langfuse", message: "Flushing events to Langfuse..." }` | `pipeline.ts:151` | Final flush |
| `done` | `{}` | `pipeline.ts:152` | Pipeline complete |

---

## Event Emission Pattern

Every stage uses the `emit(event: PipelineEvent)` callback:

```typescript
export type PipelineEvent =
  | { type: "log"; source: string; message: string; warn?: boolean }
  | { type: "scrape:done"; bookCount: number; failureCount: number; articleCount: number }
  | { type: "failure"; field: string; selector: string; error: string; totalFailures: number }
  | { type: "proposal"; field: string; proposal: HealProposal; latencyMs: number; inputTokens: number; outputTokens: number }
  | { type: "sandbox-result"; validCount: number; totalCount: number }
  | { type: "patch"; patchContent: string; outputPath: string; field: string; oldSelector: string; newSelector: string }
  | { type: "done" }
  | { type: "error"; message: string };
```

**Why?** Decouples pipeline logic from I/O:
- CLI subscribers use `console.log`
- Web subscribers use SSE to browser
- Both consume the same event stream

---

## Data Structures at Each Stage

### GenericItem
```typescript
Record<string, string>  // e.g. { title: "...", price: "...", author: "..." }
```

### ScrapeFailure
```typescript
{
  field:     string        // "price"
  selector:  string        // "span.product-price"
  domSlice:  string        // outerHTML of article element
  pageUrl:   string        // "https://example.com/books?page=1"
  zodError:  string        // stringified validation error array
  timestamp: ISO datetime  // "2025-05-13T14:23:45.123Z"
}
```

### HealProposal
```typescript
{
  new_selector: string   // "span.price" (LLM suggestion)
  confidence:   number   // 0.0–1.0 (LLM's own confidence)
  diagnosis:    string   // "Previous selector used non-existent class name"
  reasoning:    string   // "The correct element is a span with class 'price'"
}
```

### Provider (from Neon)
```typescript
{
  id:              string              // "books-abc123"
  name:            string              // "Books Scraper"
  url:             string              // "https://example.com"
  articleSelector: string              // ".product-pod"
  baseUrl?:        string              // relative href resolution
  fields:          ProviderField[]     // field definitions
  demoBreaks:      DemoBreak[]         // intentional failures for demo mode
}
```

---

## External Services & Dependencies

| Service | Purpose | When | Response |
|---|---|---|---|
| **Playwright** | Navigate & scrape pages | Stage 2 & 5 | DOM elements, outerHTML |
| **Zod** | Validate data at boundaries | Stages 2, 4, 6 | Parsed data or error |
| **Groq API** | LLM fix proposal | Stage 4 | JSON with new selector + diagnosis |
| **Neon (PostgreSQL)** | Provider config CRUD | Startup | Provider rows with fields, demoBreaks |
| **Langfuse** | Observability, tracing | Stages 4 & 7 | Trace IDs for correlation |
| **Filesystem** | Patch file output | Stage 6 | `.patch` file written to `output/` |

---

## Data Flow Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    USER INPUT                                   │
│            npm run demo | npm run serve | web UI                │
└─────────────────────┬────────────────────────────────────────────┘
                      │
                      ▼
        ┌──────────────────────────┐
        │ runPipeline(opts, emit)  │
        └──────────────┬───────────┘
                      │
        ┌─────────────┴────────────┐
        │ Load Provider from Neon   │
        └─────────────┬────────────┘
                      │
        ┌─────────────┴──────────────────┐
        │ scrapeItems(browser)           │ ──→ Playwright browser.goto()
        │   Returns:                     │
        │   - items: GenericItem[]       │
        │   - failures: ScrapeFailure[]  │
        │   - articleCount: number       │
        └─────────────┬──────────────────┘
                      │
            EMIT: scrape:done
                      │
    ┌───────────────────────────────────┐
    │ Has failures?                     │
    │ No  ──→ Done                      │
    │ Yes ──→ Dedup by field, loop:    │
    └───────────────┬───────────────────┘
                    │
            EMIT: failure
                    │
        ┌───────────┴──────────┐
        │ healSelector(groq)   │ ──→ Groq API call
        │   Returns:           │     (JSON mode)
        │   - proposal         │
        │   - inputTokens      │
        │   - outputTokens     │
        └───────────┬──────────┘
                    │
            EMIT: proposal
                    │
        ┌───────────┴────────────────┐
        │ scrapeItems (sandbox)      │ ──→ Retry with patched selector
        │ Same browser, same page    │     on live site
        └───────────┬────────────────┘
                    │
            EMIT: sandbox-result
                    │
        ┌───────────┴──────────────┐
        │ generatePatch()          │ ──→ Read selectors.ts
        │   Returns: .patch file   │     Generate unified diff
        └───────────┬──────────────┘
                    │
            EMIT: patch
                    │
        ┌───────────┴──────────────┐
        │ traceHealGeneration()    │ ──→ Langfuse
        │ appendRunHistory()       │     Filesystem
        │ flushLangfuse()          │
        └───────────┬──────────────┘
                    │
            EMIT: done
                    │
        ┌───────────┴─────────────────┐
        │ Render/display to user:     │
        │ - Console logs              │
        │ - Browser SSE stream        │
        │ - Patch file in output/     │
        └─────────────────────────────┘
```

---

## Module Responsibilities

| Module | Function | Input | Output | Dependencies |
|---|---|---|---|---|
| **pipeline.ts** | `runPipeline()` | opts, emit callback | void (emits events) | all others |
| **scrape.ts** | `scrapeItems()` | browser, selectors, fieldTypes, articleSelector, maxItems, pageUrl, baseUrl | ScrapeResult | Playwright, Zod |
| **scrape.ts** | `extractField()` | articleEl, selector, type, baseUrl | `{ value, error }` | Playwright |
| **heal.ts** | `healSelector()` | groq client, failure | HealResult | Groq SDK, Zod |
| **prompt.ts** | `buildUserPrompt()` | failure | string (prompt) | — |
| **prompt.ts** | `SYSTEM_PROMPT` | (constant) | string | — |
| **patch.ts** | `generatePatch()` | provider, field, proposal, outputDir, testedItems | PatchResult | diff, fs |
| **providers.ts** | `loadProviders()` | — | Provider[] | Neon (sql) |
| **providers.ts** | `getProvider()` | id | Provider \| null | Neon (sql) |
| **langfuse.ts** | `createLangfuseClient()` | — | Langfuse instance | Langfuse SDK |
| **langfuse.ts** | `startScrapeTrace()` | lf, pageUrl, broken | { trace, scrapeSpan } | Langfuse |
| **langfuse.ts** | `traceHealGeneration()` | trace, failure, proposal, ... | void (side effect) | Langfuse |
| **langfuse.ts** | `flushLangfuse()` | lf | Promise<void> | Langfuse |
| **index.ts** | CLI emit handler | events | void (console.log) | — |
| **server.ts** | Web emit handler | events | void (SSE to browser) | Express |

---

## Environment & Configuration

```
.env variables:
  GROQ_API_KEY              → Groq API authentication
  LANGFUSE_PUBLIC_KEY       → Langfuse SDK setup
  LANGFUSE_SECRET_KEY       → Langfuse authentication
  LANGFUSE_BASE_URL         → Langfuse cloud endpoint (default: cloud.langfuse.com)
  BROKEN_SELECTORS (opt)    → Enable demo mode selectors
  MAX_BOOKS (opt)           → Limit scrape size (default: 20)
  PORT (opt)                → Web server port (default: 3000)

Database:
  Neon PostgreSQL           → providers table
                              - id, name, url, article_selector, base_url
                              - fields: JSON array (ProviderField[])
                              - demo_breaks: JSON array (DemoBreak[])
```

---

## Error Handling

| Stage | Error Type | Handler | Outcome |
|---|---|---|---|
| Scrape | Playwright timeout | catch in `scrapeItems()` | Return partial items, emit failures |
| Scrape | Selector mismatch | Zod validation | Create ScrapeFailure, continue |
| Heal | Groq API error | catch in `healSelector()` | Throw HealerParseError, pipeline catches |
| Heal | Invalid JSON response | Zod validation | Throw HealerParseError, pipeline catches |
| Heal | LLM gibberish | `result.error.issues` | Throw HealerParseError |
| Patch | Field not in provider | throw in `generatePatch()` | Pipeline catches, emit error event |
| General | Any uncaught | try-catch in `runPipeline()` | EMIT: error, finally closes browser + flushes Langfuse |

