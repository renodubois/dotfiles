import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CurlOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  signal?: AbortSignal;
}

export interface CurlResult {
  body: string;
  finalUrl: string;
  contentType?: string;
  httpCode?: number;
  sizeDownload?: number;
}

export function curlGet(url: string, options: CurlOptions): Promise<CurlResult> {
  return new Promise(async (resolve, reject) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-"));
    const bodyPath = path.join(tmpDir, "body");
    const metaPrefix = "PI_WEB_CURL_META:";

    const args = [
      "--silent",
      "--show-error",
      "--location",
      "--compressed",
      "--max-time",
      String(Math.ceil(options.timeoutMs / 1000)),
      "--max-redirs",
      String(options.maxRedirects),
      "--max-filesize",
      String(options.maxBytes),
      "--proto",
      "=http,https",
      "--proto-redir",
      "=http,https",
      "--user-agent",
      options.userAgent,
      "--output",
      bodyPath,
      "--write-out",
      `\n${metaPrefix}{\"url_effective\":\"%{url_effective}\",\"content_type\":\"%{content_type}\",\"http_code\":%{http_code},\"size_download\":%{size_download}}`,
      url,
    ];

    const child = execFile("curl", args, { signal: options.signal, maxBuffer: 128 * 1024 }, async (error, stdout, stderr) => {
      try {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }

        const metaLine = stdout.split(/\r?\n/).find((line) => line.startsWith(metaPrefix));
        if (!metaLine) throw new Error("curl did not return metadata");
        const meta = JSON.parse(metaLine.slice(metaPrefix.length));
        const buffer = await fs.readFile(bodyPath);
        if (buffer.byteLength > options.maxBytes) {
          throw new Error(`Response exceeded maximum size of ${options.maxBytes} bytes`);
        }
        resolve({
          body: buffer.toString("utf8"),
          finalUrl: String(meta.url_effective || url),
          contentType: meta.content_type || undefined,
          httpCode: Number(meta.http_code) || undefined,
          sizeDownload: Number(meta.size_download) || undefined,
        });
      } catch (e) {
        reject(e);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    options.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  });
}
