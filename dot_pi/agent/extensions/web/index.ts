import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TtlCache } from "./src/cache.ts";
import { loadConfig } from "./src/config.ts";
import { createWebFetchTool } from "./src/tools/web-fetch.ts";
import { createWebSearchTool } from "./src/tools/web-search.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  const config = loadConfig(__dirname);
  const cache = new TtlCache<any>(
    config.cache.enabled,
    config.cache.ttlSeconds * 1000,
    config.cache.maxEntries,
  );

  pi.registerTool(createWebSearchTool(config, cache));
  pi.registerTool(createWebFetchTool(config, cache));

  // pi.on("session_start", async (_event, ctx) => {
  //   ctx.ui.setStatus("web", "web search ready");
  // });
}
