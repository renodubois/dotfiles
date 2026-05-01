import fs from "node:fs";
import path from "node:path";

export interface WebExtensionConfig {
  search: {
    provider: "duckduckgo-html";
    maxResults: number;
    timeoutMs: number;
  };
  fetch: {
    timeoutMs: number;
    maxBytes: number;
    defaultMaxChars: number;
    maxChars: number;
    maxRedirects: number;
    userAgent: string;
  };
  security: {
    allowPrivateNetworks: boolean;
    allowLocalhost: boolean;
  };
  cache: {
    enabled: boolean;
    ttlSeconds: number;
    maxEntries: number;
  };
}

export const defaultConfig: WebExtensionConfig = {
  search: { provider: "duckduckgo-html", maxResults: 5, timeoutMs: 15_000 },
  fetch: {
    timeoutMs: 15_000,
    maxBytes: 2_000_000,
    defaultMaxChars: 20_000,
    maxChars: 100_000,
    maxRedirects: 5,
    userAgent: "pi-web-extension/0.1 (+https://pi.dev)",
  },
  security: { allowPrivateNetworks: false, allowLocalhost: false },
  cache: { enabled: true, ttlSeconds: 900, maxEntries: 100 },
};

function mergeConfig(base: WebExtensionConfig, override: any): WebExtensionConfig {
  return {
    search: { ...base.search, ...(override?.search ?? {}) },
    fetch: { ...base.fetch, ...(override?.fetch ?? {}) },
    security: { ...base.security, ...(override?.security ?? {}) },
    cache: { ...base.cache, ...(override?.cache ?? {}) },
  };
}

export function loadConfig(extensionDir: string): WebExtensionConfig {
  const configPath = path.join(extensionDir, "config.json");
  if (!fs.existsSync(configPath)) return defaultConfig;
  const raw = fs.readFileSync(configPath, "utf8");
  return mergeConfig(defaultConfig, JSON.parse(raw));
}
