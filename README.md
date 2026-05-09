# Self-Healing Scraper

A working prototype of Switchup's core thesis: **Playwright fails → AI analyzes → generates fix → commits for review.**

Built as a "show, don't tell" demo. Every architectural choice mirrors the team's production bets.

---

## How it works

```text
books.toscrape.com
       │
       ▼
 Playwright scraper          ← typed CSS selector config
       │
       ▼
  Zod validation             ← RawBookSchema catches empty selectors
       │
   (on failure)
       │
       ▼
  DOM slice capture          ← outerHTML of the article element (~400 bytes)
       │
       ▼
  Gemini gemini-2.0-flash-lite    ← structured prompt → HealProposalSchema
       │
       ▼
  Sandbox retry              ← tests the proposed selector before committing
       │
       ▼
  Unified diff               ← output/selectors.patch — humans review, not auto-merged
       │
       ▼
  Langfuse trace             ← prompts, latencies, token usage, confidence scores
```

The broken selector (`span.price-amount`) is intentional — it mirrors what happens when a provider redesigns their page. The healer finds the real selector (`p.price_color`), sandboxes it against all 20 books, then emits a patch with a "tested: 20/20 valid records" annotation.

---

## Why this stack

| Switchup bet | How it shows up here |
| --- | --- |
| TypeScript + Zod for runtime chaos | `BookSchema` validates scraped data; `HealProposalSchema` validates the LLM's reply |
| Playwright for API-less providers | Real browser scraping with a typed selector config |
| AI self-healing scripts | `src/healer/heal.ts` — Gemini JSON mode, schema-validated output |
| Langfuse observability | Every scrape and heal attempt is traced with prompts, latencies, and token counts |
| Schema-driven everything | Selectors live in one typed config; the healer patches that one place |

---

## Setup

```bash
# Install dependencies
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Configure environment
cp .env.example .env
# Fill in GEMINI_API_KEY and Langfuse credentials
```

### Environment variables

```env
GEMINI_API_KEY=AIza...
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
BROKEN_SELECTORS=true
MAX_BOOKS=20
```

Get your free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

---

## Running the demo

### Full demo (broken selector → heal → patch)

```bash
npm run demo
```

Expected output:

```text
[demo] Starting self-healing scraper (demo=true, broken=true)
[scraper] Found 20 articles on https://books.toscrape.com/catalogue/page-1.html
[scraper] 0 valid books, 20 failures
[healer] 20 failures detected across 1 field(s): price
[healer] Calling Gemini gemini-2.0-flash-lite for field "price"...
[healer] Proposal: "p.price_color" (confidence: 0.97)
[healer] Diagnosis: span.price-amount does not exist; price is rendered in p.price_color
[healer] Latency: 820ms | Tokens: 892in / 87out
[sandbox] Retrying with proposed selector "p.price_color"...
[sandbox] 20/20 books valid with proposed selector
[diff] Patch written to: output/selectors.patch
[diff] Apply with: git apply output/selectors.patch
[langfuse] Events flushed
```

### Apply the patch and verify

```bash
git apply output/selectors.patch
BROKEN_SELECTORS=false npm run scrape
```

### Working selectors (no heal needed)

```bash
BROKEN_SELECTORS=false npm run scrape
```

---

## Project structure

```text
src/
├── config/
│   └── selectors.ts          # ONE source of truth for all CSS selectors
├── scraper/
│   ├── schema.ts             # RawBookSchema, BookSchema, ScrapeFailureSchema
│   └── scrape.ts             # Playwright scraping logic
├── healer/
│   ├── prompt.ts             # System prompt + per-failure user prompt builder
│   └── heal.ts               # Gemini call + HealProposalSchema validation
├── diff/
│   └── patch.ts              # Unified diff generator
├── observability/
│   └── langfuse.ts           # Langfuse client + trace/span/generation helpers
└── index.ts                  # Orchestrator
output/
└── selectors.patch           # Generated patch (gitignored)
```

---

## Key design decisions

**Selectors live in one typed record.** `SelectorConfig = Record<BookField, string>`. The healer proposes `{ field, new_selector }` and the patch generator does a targeted string replace on that one key — no scattered selector strings, no AST manipulation, clean one-line diffs.

**`domSlice` is the article element, not the full page.** Sending 60KB of HTML to Gemini is wasteful. The enclosing `article.product_pod` element (~400 bytes) contains every candidate selector the model needs. Token cost drops by ~150×.

**Gemini JSON mode.** Setting `responseMimeType: "application/json"` forces structured output — no markdown fences, no prose, just the object. The response is still validated through `HealProposalSchema` (Zod) because the model is untrusted at runtime.

**No auto-merge.** The patch file is a review artifact, not an action. Humans apply it with `git apply` after inspecting the diagnosis and confidence score. This is deliberate — automated selector changes without review are how scrapers silently break.

**Sandbox retry before the diff.** The proposed selector is tested against all 20 books before the patch is written. The patch header carries `# Tested: 20 valid records` so the reviewer knows it's not just a guess.

---

## Observability

Every run produces a Langfuse trace visible at [cloud.langfuse.com](https://cloud.langfuse.com):

- Top-level `scrape-run` trace with `brokenSelectors` metadata
- `playwright-scrape` span with book count and failure count
- `gemini-heal` generation with full prompt, response, token usage, and confidence score

---

## Verification checklist

- [ ] `npm run typecheck` — zero errors
- [ ] `BROKEN_SELECTORS=false npm run scrape` — 20 books, 0 failures, no Gemini call
- [ ] `npm run demo` — 20 failures → heal → sandbox 20/20 → patch written → Langfuse flushed
- [ ] `git apply --check output/selectors.patch` — patch applies cleanly
- [ ] Langfuse dashboard shows trace with generation event including token counts
