import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

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

const PROVIDERS_FILE = path.resolve(__dirname, "../../config/providers.json");

export function loadProviders(): Provider[] {
  if (!fs.existsSync(PROVIDERS_FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf-8")) as unknown;
  return z.array(ProviderSchema).parse(raw);
}

export function saveProviders(providers: Provider[]): void {
  const dir = path.dirname(PROVIDERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(providers, null, 2) + "\n", "utf-8");
}

export function generateId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}
