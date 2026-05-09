import Groq from "groq-sdk";
import { z } from "zod";
import { ScrapeFailure } from "../scraper/schema";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

export const HealProposalSchema = z.object({
  new_selector: z.string().min(1),
  confidence:   z.number().min(0).max(1),
  diagnosis:    z.string().min(1),
  reasoning:    z.string().min(1),
});

export type HealProposal = z.infer<typeof HealProposalSchema>;

export class HealerParseError extends Error {
  constructor(
    public readonly rawResponse: string,
    public readonly parseError: string,
  ) {
    super(`Healer returned unparseable response: ${parseError}`);
    this.name = "HealerParseError";
  }
}

export interface HealResult {
  failure:      ScrapeFailure;
  proposal:     HealProposal;
  rawResponse:  string;
  inputTokens:  number;
  outputTokens: number;
}

const MODEL = "llama-3.3-70b-versatile";

export async function healSelector(
  client:  Groq,
  failure: ScrapeFailure,
): Promise<HealResult> {
  const userPrompt = buildUserPrompt(failure);

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 512,
    // JSON mode — Groq guarantees a valid JSON object in the response
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userPrompt },
    ],
  });

  const rawResponse = response.choices[0]?.message?.content ?? "";
  const inputTokens  = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    throw new HealerParseError(rawResponse, "response is not valid JSON");
  }

  const result = HealProposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new HealerParseError(rawResponse, JSON.stringify(result.error.issues));
  }

  if (result.data.confidence < 0.5) {
    console.warn(
      `[healer] Low confidence (${result.data.confidence.toFixed(2)}) — generating patch anyway for human review`,
    );
  }

  return {
    failure,
    proposal:     result.data,
    rawResponse,
    inputTokens,
    outputTokens,
  };
}
