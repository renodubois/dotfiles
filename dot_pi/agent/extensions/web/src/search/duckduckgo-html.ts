import { JSDOM } from "jsdom";
import type { WebExtensionConfig } from "../config.ts";
import { curlGet } from "../curl.ts";
import { normalizeWhitespace } from "../text.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeDuckDuckGoUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return undefined;
  }
}

export async function duckDuckGoHtmlSearch(input: {
  query: string;
  site?: string;
  maxResults: number;
  config: WebExtensionConfig;
  signal?: AbortSignal;
}): Promise<{ query: string; results: SearchResult[] }> {
  const query = input.site ? `site:${input.site} ${input.query}` : input.query;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await curlGet(searchUrl, {
    timeoutMs: input.config.search.timeoutMs,
    maxBytes: input.config.fetch.maxBytes,
    maxRedirects: input.config.fetch.maxRedirects,
    userAgent: input.config.fetch.userAgent,
    signal: input.signal,
  });

  const dom = new JSDOM(response.body);
  const document = dom.window.document;
  const results: SearchResult[] = [];

  for (const node of Array.from(document.querySelectorAll(".result"))) {
    const anchor = node.querySelector<HTMLAnchorElement>(".result__a");
    if (!anchor) continue;
    const url = decodeDuckDuckGoUrl(anchor.getAttribute("href") || "");
    if (!url) continue;
    const title = normalizeWhitespace(anchor.textContent || "");
    const snippet = normalizeWhitespace(node.querySelector(".result__snippet")?.textContent || "");
    if (!title) continue;
    results.push({ title, url, snippet });
    if (results.length >= input.maxResults) break;
  }

  return { query, results };
}
