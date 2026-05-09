import { z } from "zod";

// Generic raw item — any field names, all string values, all non-empty
export const GenericItemSchema = z.record(z.string(), z.string().min(1));
export type GenericItem = z.infer<typeof GenericItemSchema>;

// Failure context passed from the scraper to the healer
export const ScrapeFailureSchema = z.object({
  field:     z.string(),
  selector:  z.string(),
  domSlice:  z.string(),
  pageUrl:   z.url(),
  zodError:  z.string(),
  timestamp: z.iso.datetime(),
});

export type ScrapeFailure = z.infer<typeof ScrapeFailureSchema>;
