import * as fs from "fs";
import * as path from "path";

export interface RunSummary {
  scraped:  number;
  valid:    number;
  failures: number;
}

export interface RunProposal {
  field:       string;
  oldSelector: string;
  newSelector: string;
  confidence:  number;
}

export interface RunHistoryEntry {
  id:           string;
  timestamp:    string;
  providerId:   string;
  providerName: string;
  mode:         "demo" | "live";
  summary:      RunSummary;
  proposals:    RunProposal[];
}

const MAX_ENTRIES = 50;

function historyPath(outputDir: string): string {
  return path.join(outputDir, "run-history.json");
}

export function appendRunHistory(outputDir: string, entry: RunHistoryEntry): void {
  const file = historyPath(outputDir);
  const existing: RunHistoryEntry[] = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf-8")) as RunHistoryEntry[])
    : [];
  const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

export function loadRunHistory(outputDir: string): RunHistoryEntry[] {
  const file = historyPath(outputDir);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8")) as RunHistoryEntry[];
}
