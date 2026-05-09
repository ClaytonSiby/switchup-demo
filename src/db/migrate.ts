import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { sql } from "./index";
import { ProviderSchema } from "../config/providers";

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS providers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      url             TEXT NOT NULL,
      article_selector TEXT NOT NULL,
      base_url        TEXT,
      fields          JSONB NOT NULL DEFAULT '[]',
      demo_breaks     JSONB NOT NULL DEFAULT '[]'
    )
  `;
  console.log("[migrate] Table ready");

  const rows = await sql`SELECT COUNT(*)::int AS count FROM providers`;
  const count = (rows[0] as { count: number }).count;

  if (count === 0) {
    const filePath = path.resolve(__dirname, "../../config/providers.json");
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      const providers = z.array(ProviderSchema).parse(raw);
      for (const p of providers) {
        await sql`
          INSERT INTO providers (id, name, url, article_selector, base_url, fields, demo_breaks)
          VALUES (
            ${p.id}, ${p.name}, ${p.url}, ${p.articleSelector},
            ${p.baseUrl ?? null},
            ${JSON.stringify(p.fields)}::jsonb,
            ${JSON.stringify(p.demoBreaks)}::jsonb
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
      console.log(`[migrate] Seeded ${providers.length} provider(s) from providers.json`);
    }
  } else {
    console.log(`[migrate] ${count} provider(s) already in DB, skipping seed`);
  }
}

migrate().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
