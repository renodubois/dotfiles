import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { normalizeWhitespace } from "../text.ts";

export interface ExtractedPage {
  title?: string;
  text: string;
}

export function extractReadableText(html: string, url: string): ExtractedPage {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document.cloneNode(true) as Document);
  const article = reader.parse();

  if (article?.textContent && article.textContent.trim().length > 200) {
    return {
      title: article.title || dom.window.document.title || undefined,
      text: normalizeWhitespace(article.textContent),
    };
  }

  const document = dom.window.document;
  for (const selector of ["script", "style", "noscript", "svg", "canvas", "nav", "header", "footer"]) {
    for (const el of Array.from(document.querySelectorAll(selector))) el.remove();
  }

  return {
    title: document.title || undefined,
    text: normalizeWhitespace(document.body?.textContent || document.documentElement.textContent || ""),
  };
}
