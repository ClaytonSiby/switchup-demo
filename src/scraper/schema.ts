import { z } from "zod";

// Raw scraped data — strings only, before any transformation
export const RawBookSchema = z.object({
  title:        z.string().min(1, "title selector returned empty"),
  price:        z.string().min(1, "price selector returned empty"),
  rating:       z.string().min(1, "rating selector returned empty"),
  availability: z.string().min(1, "availability selector returned empty"),
  url:          z.string().url(),
});

export type RawBook = z.infer<typeof RawBookSchema>;

// Clean typed output after transformation
export const BookSchema = z.object({
  title:        z.string().min(1),
  price:        z.number().positive(),
  rating:       z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  availability: z.enum(["In stock", "Out of stock"]),
  url:          z.string().url(),
});

export type Book = z.infer<typeof BookSchema>;

// Failure context passed from the scraper to the healer
export const ScrapeFailureSchema = z.object({
  field:     z.string(),
  selector:  z.string(),
  domSlice:  z.string(),
  pageUrl:   z.string().url(),
  zodError:  z.string(),
  timestamp: z.string().datetime(),
});

export type ScrapeFailure = z.infer<typeof ScrapeFailureSchema>;
