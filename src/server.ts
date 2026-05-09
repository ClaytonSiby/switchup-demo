import "dotenv/config";
import express, { Request, Response } from "express";
import * as path from "path";
import { chromium } from "playwright";
import { runPipeline, PipelineEvent } from "./pipeline";
import {
  loadProviders,
  saveProviders,
  generateId,
  ProviderSchema,
  Provider,
} from "./config/providers";
import { loadRunHistory } from "./config/run-history";

const app  = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

const OUTPUT_DIR = path.join(__dirname, "../output");

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// ── Providers ────────────────────────────────────────────────────────────────

app.get("/api/providers", (_req, res: Response) => {
  res.json(loadProviders());
});

app.post("/api/providers", (req: Request, res: Response) => {
  const body = req.body as unknown;
  const parsed = ProviderSchema.omit({ id: true }).safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const providers = loadProviders();
  const provider: Provider = { id: generateId(parsed.data.name), ...parsed.data };
  providers.push(provider);
  saveProviders(providers);
  res.status(201).json(provider);
});

app.put("/api/providers/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body as unknown;
  const parsed = ProviderSchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const providers = loadProviders();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) { res.status(404).json({ error: "Not found" }); return; }
  providers[idx] = parsed.data;
  saveProviders(providers);
  res.json(providers[idx]);
});

app.delete("/api/providers/:id", (req: Request, res: Response) => {
  const { id } = req.params;
  const providers = loadProviders();
  const idx = providers.findIndex((p) => p.id === id);
  if (idx === -1) { res.status(404).json({ error: "Not found" }); return; }
  providers.splice(idx, 1);
  saveProviders(providers);
  res.status(204).end();
});

// ── Run History ───────────────────────────────────────────────────────────────

app.get("/api/history", (_req, res: Response) => {
  res.json(loadRunHistory(OUTPUT_DIR));
});

// ── Selector Test ─────────────────────────────────────────────────────────────

app.post("/api/test-selector", async (req: Request, res: Response) => {
  const { url, articleSelector, fieldSelector, fieldType } =
    req.body as { url: string; articleSelector: string; fieldSelector: string; fieldType: string };

  if (!url || !articleSelector || !fieldSelector) {
    res.status(400).json({ error: "url, articleSelector, and fieldSelector are required" });
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const articles = page.locator(articleSelector);
    const articleCount = await articles.count();
    if (articleCount === 0) {
      await page.close();
      res.json({ count: 0, samples: [], error: `articleSelector "${articleSelector}" matched 0 elements` });
      return;
    }

    const samples: string[] = [];
    const limit = Math.min(articleCount, 5);
    for (let i = 0; i < limit; i++) {
      const article = articles.nth(i);
      const el = article.locator(fieldSelector).first();
      if (await el.count() === 0) continue;

      let value = "";
      if (fieldType === "href") {
        value = (await el.getAttribute("href")) ?? "";
      } else if (fieldType === "class") {
        value = (await el.getAttribute("class")) ?? "";
      } else {
        value = (await el.textContent())?.trim() ?? "";
      }
      if (value) samples.push(value);
    }

    await page.close();
    res.json({ count: samples.length, samples });
  } catch (err) {
    res.json({ count: 0, samples: [], error: String(err) });
  } finally {
    await browser.close();
  }
});

// ── Pipeline Run (SSE) ────────────────────────────────────────────────────────

app.get("/api/run", async (req: Request, res: Response) => {
  const providerId = (req.query["providerId"] as string | undefined) ?? "";
  const demo = req.query["demo"] === "true";

  const providers = loadProviders();
  const provider = providerId
    ? providers.find((p) => p.id === providerId)
    : providers[0];

  if (!provider) {
    res.status(400).json({ error: "No provider found. Add one in the config panel." });
    return;
  }

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (event: PipelineEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runPipeline(
      {
        provider,
        demo,
        maxItems:  parseInt(process.env.MAX_BOOKS ?? "20", 10),
        outputDir: OUTPUT_DIR,
      },
      send,
    );
  } catch (err) {
    send({ type: "error", message: String(err) });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] Dashboard → http://localhost:${PORT}`);
});
