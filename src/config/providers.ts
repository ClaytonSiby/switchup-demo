import { z } from "zod";
import { sql } from "../db";

export const FieldTypeSchema = z.enum(["text", "href", "class"]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const ProviderFieldSchema = z.object({
  name:     z.string().min(1),
  selector: z.string().min(1),
  type:     FieldTypeSchema.default("text"),
});
export type ProviderField = z.infer<typeof ProviderFieldSchema>;

export const DemoBreakSchema = z.object({
  field:    z.string().min(1),
  selector: z.string().min(1),
});
export type DemoBreak = z.infer<typeof DemoBreakSchema>;

export const ProviderSchema = z.object({
  id:              z.string().min(1),
  name:            z.string().min(1),
  url:             z.url(),
  articleSelector: z.string().min(1),
  baseUrl:         z.string().optional(),
  fields:          z.array(ProviderFieldSchema).min(1),
  demoBreaks:      z.array(DemoBreakSchema).default([]),
});
export type Provider = z.infer<typeof ProviderSchema>;

type DbRow = {
  id:               string;
  name:             string;
  url:              string;
  article_selector: string;
  base_url:         string | null;
  fields:           ProviderField[];
  demo_breaks:      DemoBreak[];
};

function rowToProvider(row: DbRow): Provider {
  return {
    id:              row.id,
    name:            row.name,
    url:             row.url,
    articleSelector: row.article_selector,
    baseUrl:         row.base_url ?? undefined,
    fields:          z.array(ProviderFieldSchema).parse(row.fields),
    demoBreaks:      z.array(DemoBreakSchema).parse(row.demo_breaks),
  };
}

export async function loadProviders(): Promise<Provider[]> {
  const rows = await sql`SELECT * FROM providers ORDER BY name` as DbRow[];
  return rows.map(rowToProvider);
}

export async function getProvider(id: string): Promise<Provider | null> {
  const rows = await sql`SELECT * FROM providers WHERE id = ${id}` as DbRow[];
  return rows.length > 0 ? rowToProvider(rows[0]) : null;
}

export async function createProvider(provider: Provider): Promise<void> {
  await sql`
    INSERT INTO providers (id, name, url, article_selector, base_url, fields, demo_breaks)
    VALUES (
      ${provider.id}, ${provider.name}, ${provider.url}, ${provider.articleSelector},
      ${provider.baseUrl ?? null},
      ${JSON.stringify(provider.fields)}::jsonb,
      ${JSON.stringify(provider.demoBreaks)}::jsonb
    )
  `;
}

export async function updateProvider(provider: Provider): Promise<boolean> {
  const rows = await sql`
    UPDATE providers
    SET name             = ${provider.name},
        url              = ${provider.url},
        article_selector = ${provider.articleSelector},
        base_url         = ${provider.baseUrl ?? null},
        fields           = ${JSON.stringify(provider.fields)}::jsonb,
        demo_breaks      = ${JSON.stringify(provider.demoBreaks)}::jsonb
    WHERE id = ${provider.id}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function deleteProvider(id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM providers WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export function generateId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
