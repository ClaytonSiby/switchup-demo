import "dotenv/config";
import express from "express";
import * as path from "path";
import { runPipeline, PipelineEvent } from "./pipeline";

const app  = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/run", async (_req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (event: PipelineEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runPipeline(
      {
        demo:      true,
        maxBooks:  parseInt(process.env.MAX_BOOKS ?? "60", 10),
        outputDir: path.join(__dirname, "../output"),
        targetUrl: "https://books.toscrape.com/catalogue/page-1.html",
      },
      send,
    );
  } catch (err) {
    send({ type: "error", message: String(err) });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`[server] Dashboard → http://localhost:${PORT}`);
});
