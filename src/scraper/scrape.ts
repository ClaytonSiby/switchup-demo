import { Browser, Page, Locator } from "playwright";
import { GenericItem, ScrapeFailure } from "./schema";

export type FieldType = "text" | "href" | "class";

export interface ScrapeResult {
  items:        GenericItem[];
  failures:     ScrapeFailure[];
  pageUrl:      string;
  articleCount: number;
}

async function extractField(
  articleEl:   Locator,
  selector:    string,
  type:        FieldType,
  baseUrl:     string,
): Promise<{ value: string; error: string | null }> {
  try {
    const el = articleEl.locator(selector).first();
    if (await el.count() === 0) {
      return { value: "", error: `selector "${selector}" matched 0 elements` };
    }

    let value = "";
    if (type === "href") {
      const href = await el.getAttribute("href");
      value = href ? new URL(href, baseUrl).toString() : "";
    } else if (type === "class") {
      value = (await el.getAttribute("class")) ?? "";
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

export async function scrapeItems(
  browser:         Browser,
  selectors:       Record<string, string>,
  fieldTypes:      Record<string, FieldType>,
  articleSelector: string,
  maxItems:        number,
  pageUrl:         string,
  baseUrl:         string,
): Promise<ScrapeResult> {
  const page: Page = await browser.newPage();
  const items: GenericItem[] = [];
  const failures: ScrapeFailure[] = [];
  let articleCount = 0;

  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

    const articles = page.locator(articleSelector);
    const count = Math.min(await articles.count(), maxItems);
    articleCount = count;

    for (let i = 0; i < count; i++) {
      const article = articles.nth(i);
      const domSlice = await article.evaluate((el) => el.outerHTML);

      const raw: Record<string, string> = {};
      let articleFailed = false;

      for (const field of Object.keys(selectors)) {
        const type = fieldTypes[field] ?? "text";
        const { value, error } = await extractField(
          article,
          selectors[field],
          type,
          baseUrl,
        );

        if (error || !value) {
          failures.push({
            field,
            selector:  selectors[field],
            domSlice,
            pageUrl,
            zodError:  JSON.stringify([{ message: error ?? "empty value", path: [field] }]),
            timestamp: new Date().toISOString(),
          });
          articleFailed = true;
        } else {
          raw[field] = value;
        }
      }

      if (!articleFailed) {
        items.push(raw as GenericItem);
      }
    }
  } finally {
    await page.close();
  }

  return { items, failures, pageUrl, articleCount };
}
