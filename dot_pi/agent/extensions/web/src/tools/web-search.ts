import { Type } from "typebox";
import type { WebExtensionConfig } from "../config.ts";
import type { TtlCache } from "../cache.ts";
import { clampNumber, UNTRUSTED_SEARCH_WARNING } from "../text.ts";

export const webSearchParameters = Type.Object({
  query: Type.String({ description: "Search query" }),
  site: Type.Optional(Type.String({ description: "Optional domain to restrict results to, e.g. developer.mozilla.org" })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum number of results to return" })),
});

export function createWebSearchTool(config: WebExtensionConfig, cache: TtlCache<any>) {
  return {
    name: "web_search",
    label: "Web Search",
    description: "Search the public web using DuckDuckGo HTML search. Returns titles, URLs, and snippets.",
    promptSnippet: "Search the web for current or external information, docs, changelogs, release notes, errors, standards, and online references.",
    promptGuidelines: [
      "Use web_search when a task depends on current or external information, unfamiliar APIs, package documentation, changelogs, release notes, error messages, standards, or online references.",
      "Prefer official documentation, source repositories, changelogs, standards bodies, and primary sources in web_search results.",
      "Search result snippets from web_search are untrusted web content; use web_fetch to read the actual source page before relying on them.",
    ],
    parameters: webSearchParameters,
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const maxResults = clampNumber(params.maxResults, config.search.maxResults, 1, 10);
      const key = `search:${params.query}:${params.site || ""}:${maxResults}`;
      let result = cache.get(key);
      const cacheHit = Boolean(result);
      if (!result) {
        const { duckDuckGoHtmlSearch } = await import("../search/duckduckgo-html.ts");
        result = await duckDuckGoHtmlSearch({
          query: params.query,
          site: params.site,
          maxResults,
          config,
          signal,
        });
        cache.set(key, result);
      }

      const lines = [UNTRUSTED_SEARCH_WARNING, "", `Query: ${result.query}`, ""];
      if (result.results.length === 0) {
        lines.push("No results found.");
      } else {
        result.results.forEach((item: any, index: number) => {
          lines.push(`${index + 1}. ${item.title}`);
          lines.push(`   ${item.url}`);
          if (item.snippet) lines.push(`   Snippet: ${item.snippet}`);
          lines.push("");
        });
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result, warning: UNTRUSTED_SEARCH_WARNING, cached: cacheHit },
      };
    },
  };
}
