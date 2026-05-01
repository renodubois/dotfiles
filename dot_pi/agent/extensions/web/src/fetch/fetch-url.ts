import type { WebExtensionConfig } from "../config.ts";
import { curlGet } from "../curl.ts";
import { assertSafePublicHttpUrl } from "../security.ts";
import { truncateText } from "../text.ts";
import { extractReadableText } from "./readability.ts";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  title?: string;
  contentType?: string;
  httpCode?: number;
  text: string;
  truncated: boolean;
}

export async function fetchUrl(input: {
  url: string;
  maxChars: number;
  config: WebExtensionConfig;
  signal?: AbortSignal;
}): Promise<FetchedPage> {
  const url = await assertSafePublicHttpUrl(input.url, input.config);
  const response = await curlGet(url.href, {
    timeoutMs: input.config.fetch.timeoutMs,
    maxBytes: input.config.fetch.maxBytes,
    maxRedirects: input.config.fetch.maxRedirects,
    userAgent: input.config.fetch.userAgent,
    signal: input.signal,
  });

  // Best-effort validation of the final URL after redirects. curl has already fetched it, but we still
  // refuse to return content from private/local targets.
  await assertSafePublicHttpUrl(response.finalUrl, input.config);

  const contentType = response.contentType?.toLowerCase() || "";
  let title: string | undefined;
  let text: string;

  if (contentType.includes("html") || response.body.trimStart().startsWith("<")) {
    const extracted = extractReadableText(response.body, response.finalUrl);
    title = extracted.title;
    text = extracted.text;
  } else {
    text = response.body.trim();
  }

  const truncated = truncateText(text || "[No readable text extracted]", input.maxChars);
  return {
    url: url.href,
    finalUrl: response.finalUrl,
    title,
    contentType: response.contentType,
    httpCode: response.httpCode,
    text: truncated.text,
    truncated: truncated.truncated,
  };
}
