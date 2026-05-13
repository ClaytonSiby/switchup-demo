# CLAUDE.md

## Project overview

Self-healing web scraper demo. Core loop:

```
Playwright scrapes → Zod validates → failure captured → LLM proposes fix → sandbox tested → unified diff emitted
```

No auto-merge. Every fix goes through human review. That is a design decision, not a limitation.

---

## Architecture

### Entry points

| Command | File | Purpose |
|---|---|---|
| `npm run demo` | `src/index.ts` | CLI — runs pipeline with broken selectors |
| `npm run scrape` | `src/index.ts` | CLI — runs pipeline with working selectors |
| `npm run serve` | `src/server.ts` | Web dashboard at http://localhost:3000 |

### Pipeline

All orchestration lives in `src/pipeline.ts`. Both the CLI and server import `runPipeline()` from it. Neither entry point contains business logic — they only handle I/O (console vs. SSE).

```
src/pipeline.ts          ← runPipeline(opts, emit) — single source of truth
src/index.ts             ← CLI emit handler
src/server.ts            ← SSE emit handler → public/index.html
```

### Event system

`runPipeline` communicates exclusively through typed `PipelineEvent` emissions — never via `console.log` or side effects. Every consumer (CLI, browser) subscribes to the same event union:

```typescript
type PipelineEvent =
  | { type: "log"; source: string; message: string; warn?: boolean }
  | { type: "scrape:done"; bookCount: number; failureCount: number; articleCount: number }
  | { type: "failure"; field: string; selector: string; error: string; totalFailures: number }
  | { type: "proposal"; field: string; proposal: HealProposal; latencyMs: number; inputTokens: number; outputTokens: number }
  | { type: "sandbox-result"; validCount: number; totalCount: number }
  | { type: "patch"; patchContent: string; outputPath: string; field: string; oldSelector: string; newSelector: string }
  | { type: "done" }
  | { type: "error"; message: string };
```

Do not add `console.log` inside `pipeline.ts`, `scrape.ts`, `heal.ts`, or any module imported by the pipeline. All output must flow through `emit`.

---

## Key files

| File | What it owns |
|---|---|
| `src/config/providers.ts` | `ProviderSchema` and CRUD helpers (`loadProviders`, `getProvider`, etc.) backed by Neon. Providers are the single source of truth for selectors, fields, and demo breaks. |
| `src/scraper/schema.ts` | Two Zod schemas: `GenericItemSchema` (`z.record(string, string)` — works for any provider's fields), `ScrapeFailureSchema` (failure context passed to healer). |
| `src/healer/heal.ts` | Groq API call. `HealProposalSchema` validates the LLM response — treat model output as untrusted data, same as any external API. |
| `src/healer/prompt.ts` | System prompt and per-failure user prompt builder. Change prompts here only. |
| `src/diff/patch.ts` | Reads `selectors.ts` as raw source text, string-replaces the broken value, diffs with the `diff` package. Output is a `.patch` file applicable with `git apply`. |
| `src/observability/langfuse.ts` | Langfuse client. Always call `flushAsync()` before process exit — events are buffered in memory. |
| `public/index.html` | Single-file dashboard. No build step. Vanilla JS + CSS. SSE client via `fetch` + `ReadableStream`. |

---

## Development commands

```bash
npm run typecheck        # must pass before any commit
npm run demo             # CLI demo: broken selector → heal → patch
npm run scrape           # CLI: working selectors (no healer fires)
npm run serve            # web dashboard at http://localhost:3000
npm run build            # compile to dist/
```

---

## Conventions

### Schema-first
Every external boundary is validated with Zod at runtime — scraped data (`GenericItemSchema`), LLM output (`HealProposalSchema`), failure context (`ScrapeFailureSchema`), provider config (`ProviderSchema`). TypeScript types alone are not sufficient at runtime boundaries.

### Selectors live in the database
All CSS selectors are stored as provider fields in Neon (loaded via `loadProviders()`). The healer patches exactly one field key. This makes diffs a single-line change and `git apply` reliable.

### DOM slice, not full page
`scrapeItems` captures the outerHTML of each article element (~400 bytes) per article, not the full page HTML (~60KB). This is what gets sent to the LLM. Do not change this to send full-page HTML — it inflates token cost ~150× with no benefit.

### No auto-merge
The patch file is a review artifact. The pipeline never writes directly to provider config. A human runs `git apply output/<provider-id>-selectors.patch` after reviewing the confidence score, diagnosis, and sandbox results.

### Zod v4 API
This project uses Zod v4. Use `.issues` not `.errors` on `ZodError`. Use `z.union([...])` not `z.enum` for literal unions.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | Yes | Groq API key — get from console.groq.com/keys (free tier) |
| `LANGFUSE_PUBLIC_KEY` | Yes | Langfuse public key |
| `LANGFUSE_SECRET_KEY` | Yes | Langfuse secret key |
| `LANGFUSE_BASE_URL` | Yes | Default: `https://cloud.langfuse.com` |
| `BROKEN_SELECTORS` | No | Set to `true` to use broken selectors in `npm run scrape`. `npm run demo` sets this automatically. |
| `MAX_BOOKS` | No | Max articles to scrape per page. Default: `20`. |
| `PORT` | No | Web server port. Default: `3000`. |

Copy `.env.example` to `.env` and fill in credentials before running anything.

---

## Adding a new provider / scrape target

1. Insert a row into the `providers` table (via the web UI or `createProvider()`) with `id`, `name`, `url`, `articleSelector`, and the `fields` array
2. Each field needs a `name`, `selector`, and `type` (`"text"` | `"href"` | `"class"`)
3. Optionally add `demoBreaks` entries to simulate broken selectors in demo mode
4. The healer, diff, and observability layers need no changes — they operate on the generic failure context and selector map, not the specific target

---

## What not to do

- **Do not** add `console.log` inside `src/pipeline.ts` or any module it imports
- **Do not** call `healSelector` more than once per unique failing field per run — deduplicate in the pipeline
- **Do not** auto-apply the patch — the human-in-the-loop review step is intentional
- **Do not** send full-page HTML to the LLM — always send the article element slice
- **Do not** use `result.error.errors` (Zod v3 API) — use `result.error.issues`
- **Do not** add Tailwind or a JS framework to `public/index.html` — it is intentionally dependency-free
