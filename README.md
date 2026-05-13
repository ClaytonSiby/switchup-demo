<img width="1279" height="720" alt="switchup_scrapper" src="https://github.com/user-attachments/assets/8067916e-6eed-45ca-b690-29d1541af8ee" />

# Self-Healing Scraper

A working prototype of Switchup's core thesis: **Playwright fails → AI analyzes → generates fix → commits for review.**

Built as a "show, don't tell" demo. Every architectural choice mirrors the team's production bets.

---

## How it works

```text
Any target URL
       │
       ▼
 Playwright scraper          ← provider config loaded from Neon Postgres
       │
       ▼
  Zod validation             ← schema catches empty / mismatched selectors
       │
   (on failure)
       │
       ▼
  DOM slice capture          ← outerHTML of the article element (~400 bytes)
       │
       ▼
  Groq llama-3.3-70b         ← structured prompt → HealProposalSchema
       │
       ▼
  Sandbox retry              ← tests the proposed selector before committing
       │
       ▼
  Unified diff               ← output/*.patch — humans review, not auto-merged
       │
       ▼
  Langfuse trace             ← prompts, latencies, token usage, confidence scores
```

Providers are configured at runtime — no code changes needed to add a new scrape target. The healer, diff, and observability layers are provider-agnostic.

---

## Why this stack

| Switchup bet | How it shows up here |
| --- | --- |
| TypeScript + Zod for runtime chaos | `BookSchema` validates scraped data; `HealProposalSchema` validates the LLM's reply |
| Playwright for API-less providers | Real browser scraping — JS-rendered pages work out of the box |
| AI self-healing scripts | `src/healer/heal.ts` — Groq JSON mode, schema-validated output |
| Neon Postgres for persistence | Providers survive server restarts; add targets via the UI, not config files |
| Langfuse observability | Every scrape and heal attempt is traced with prompts, latencies, and token counts |
| Schema-driven everything | Selectors live in one typed provider config; the healer patches that one place |

---

## Setup

```bash
# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Configure environment
cp .env.example .env
# Fill in credentials (see below)

# Create the providers table and seed initial data
npm run db:migrate
```

### Environment variables

```env
GROQ_API_KEY=gsk_...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
DATABASE_URL=postgresql://...
MAX_BOOKS=20
```

| Variable | Where to get it |
| --- | --- |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) — free tier |
| `LANGFUSE_*` | [cloud.langfuse.com](https://cloud.langfuse.com) |
| `DATABASE_URL` | [console.neon.tech](https://console.neon.tech) — free tier |

---

## Running

### Web dashboard

```bash
npm run serve
```

Opens at `http://localhost:3000`. Add providers, run the pipeline, and inspect results — all from the UI.

### CLI demo (broken selector → heal → patch)

```bash
npm run demo
```

Runs the Books to Scrape provider with an intentionally broken selector (`span.price-amount`). The healer finds the correct one (`p.price_color`), sandboxes it, and writes a patch.

### CLI scrape (working selectors)

```bash
npm run scrape
```

---

## Project structure

```text
src/
├── config/
│   └── providers.ts          # Provider schema + Neon DB read/write functions
├── db/
│   ├── index.ts              # Neon client
│   └── migrate.ts            # Table creation + seed from providers.json
├── scraper/
│   ├── schema.ts             # RawBookSchema, BookSchema, ScrapeFailureSchema
│   └── scrape.ts             # Playwright scraping logic
├── healer/
│   ├── prompt.ts             # System prompt + per-failure user prompt builder
│   └── heal.ts               # Groq call + HealProposalSchema validation
├── diff/
│   └── patch.ts              # Unified diff generator
├── observability/
│   └── langfuse.ts           # Langfuse client + trace/span/generation helpers
├── pipeline.ts               # Orchestrator — single source of truth for run logic
├── server.ts                 # Express server + SSE — web dashboard backend
└── index.ts                  # CLI entry point
config/
└── providers.json            # Seed data only — gitignored after first migrate
output/
└── *.patch                   # Generated patches (gitignored)
public/
└── index.html                # Single-file dashboard — no build step, no framework
```

---

## Key design decisions

**Providers live in Neon, not config files.** Adding a scrape target is a UI action, not a deploy. Provider data survives server restarts, and multiple instances share the same state.

**`domSlice` is the article element, not the full page.** Sending 60KB of HTML to the LLM is wasteful. The enclosing article element (~400 bytes) contains every candidate selector the model needs. Token cost drops ~150×.

**Groq JSON mode.** The response is forced into a structured schema via `HealProposalSchema` (Zod) — model output is treated as untrusted data, same as any external API.

**No auto-merge.** The patch file is a review artifact, not an action. Humans apply it with `git apply` after inspecting the diagnosis and confidence score. Automated selector changes without review are how scrapers silently break.

**Sandbox retry before the diff.** The proposed selector is tested against live data before the patch is written. The patch header carries a `Tested: N valid records` annotation so the reviewer knows it's not a guess.

**Single `runPipeline` function.** Both the CLI and the web server call the same `runPipeline(opts, emit)`. Neither entry point contains business logic — they only differ in how they handle events (console vs. SSE).

---

## Observability

Every run produces a Langfuse trace at [cloud.langfuse.com](https://cloud.langfuse.com):

- Top-level `scrape-run` trace with provider metadata
- `playwright-scrape` span with article count and failure count
- `groq-heal` generation with full prompt, response, token usage, and confidence score

---

## Deployment

Deployed on [Render](https://render.com). Configuration is in `render.yaml`.

Required env vars in the Render dashboard: `GROQ_API_KEY`, `LANGFUSE_*`, `DATABASE_URL`, `PLAYWRIGHT_BROWSERS_PATH`.

---

## Verification checklist

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run db:migrate` — table created, providers seeded
- [ ] `npm run scrape` — valid items scraped, 0 failures, no healer call
- [ ] `npm run demo` — failures detected → heal → sandbox → patch written → Langfuse flushed
- [ ] `npm run serve` → add a provider via UI → restart server → provider still visible
