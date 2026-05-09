import { Browser, Page, Locator } from "playwright";
import { SelectorConfig, BookField } from "../config/selectors";
import { RawBook, RawBookSchema, ScrapeFailure } from "./schema";

export interface ScrapeResult {
  books:        RawBook[];
  failures:     ScrapeFailure[];
  pageUrl:      string;
  articleCount: number;
}

const RATING_WORDS: Record<string, number> = {
  One: 1, Two: 2, Three: 3, Four: 4, Five: 5,
};

function parseRatingClass(rawClass: string): number {
  for (const [word, num] of Object.entries(RATING_WORDS)) {
    if (rawClass.includes(word)) return num;
  }
  return 0;
}

async function extractField(
  _page: Page,
  articleEl: Locator,
  field: BookField,
  selector: string,
  baseUrl: string,
): Promise<{ value: string; error: string | null }> {
  try {
    const el = articleEl.locator(selector).first();
    const count = await el.count();
    if (count === 0) {
      return { value: "", error: `selector "${selector}" matched 0 elements` };
    }

    let value = "";
    if (field === "url") {
      const href = await el.getAttribute("href");
      value = href ? new URL(href, baseUrl).toString() : "";
    } else if (field === "rating") {
      const cls = await el.getAttribute("class") ?? "";
      const num = parseRatingClass(cls);
      value = num > 0 ? String(num) : "";
    } else {
      value = (await el.textContent())?.trim() ?? "";
    }

    return value
      ? { value, error: null }
      : { value: "", error: `selector "${selector}" matched but returned empty content` };
  } catch (err) {
    return { value: "", error: String(err) };
  }
}

export async function scrapeBooks(
  browser: Browser,
  selectors: SelectorConfig,
  maxBooks: number,
  pageUrl = "https://books.toscrape.com/catalogue/page-1.html",
): Promise<ScrapeResult> {
  const page: Page = await browser.newPage();
  const books: RawBook[] = [];
  const failures: ScrapeFailure[] = [];
  let articleCount = 0;

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

    const articles = page.locator("article.product_pod");
    const count = Math.min(await articles.count(), maxBooks);
    articleCount = count;

    for (let i = 0; i < count; i++) {
      const article = articles.nth(i);
      const domSlice = await article.evaluate((el) => el.outerHTML);

      const raw: Record<string, string> = {};
      let articleFailed = false;

      for (const field of Object.keys(selectors) as BookField[]) {
        const { value, error } = await extractField(
          page,
          article,
          field,
          selectors[field],
          "https://books.toscrape.com/catalogue/",
        );

        if (error || !value) {
          failures.push({
            field,
            selector: selectors[field],
            domSlice,
            pageUrl,
            zodError: JSON.stringify([{ message: error ?? "empty value", path: [field] }]),
            timestamp: new Date().toISOString(),
          });
          articleFailed = true;
        } else {
          raw[field] = value;
        }
      }

      if (!articleFailed) {
        const result = RawBookSchema.safeParse(raw);
        if (result.success) {
          books.push(result.data);
        } else {
          const firstIssue = result.error.issues[0];
          failures.push({
            field: String(firstIssue.path[0] ?? "unknown"),
            selector: selectors[firstIssue.path[0] as BookField] ?? "",
            domSlice,
            pageUrl,
            zodError: JSON.stringify(result.error.issues),
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  } finally {
    await page.close();
  }

  return { books, failures, pageUrl, articleCount };
}

