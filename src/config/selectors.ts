export type BookField = "title" | "price" | "rating" | "availability" | "url";

export type SelectorConfig = Record<BookField, string>;

export const WORKING_SELECTORS: SelectorConfig = {
  title:        "h3 > a",
  price:        "p.price_color",
  rating:       "p.star-rating",
  availability: "p.availability",
  url:          "h3 > a",
};

// INTENTIONALLY BROKEN — "span.price-amount" does not exist on books.toscrape.com.
// Mirrors what happens when a provider redesigns their page.
// The healer pipeline will detect this failure, call Groq, and produce a patch.
export const BROKEN_SELECTORS: SelectorConfig = {
  ...WORKING_SELECTORS,
  price: "span.price-amount",
};

export const SELECTORS: SelectorConfig =
  process.env.BROKEN_SELECTORS === "true" ? BROKEN_SELECTORS : WORKING_SELECTORS;
