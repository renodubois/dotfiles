import dns from "node:dns/promises";
import net from "node:net";
import type { WebExtensionConfig } from "./config.ts";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function ipv4InCidr(ip: string, cidrBase: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(cidrBase) & mask);
}

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return (
      ipv4InCidr(ip, "0.0.0.0", 8) ||
      ipv4InCidr(ip, "10.0.0.0", 8) ||
      ipv4InCidr(ip, "127.0.0.0", 8) ||
      ipv4InCidr(ip, "169.254.0.0", 16) ||
      ipv4InCidr(ip, "172.16.0.0", 12) ||
      ipv4InCidr(ip, "192.168.0.0", 16) ||
      ipv4InCidr(ip, "224.0.0.0", 4) ||
      ip === "255.255.255.255"
    );
  }
  if (kind === 6) {
    const normalized = ip.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      normalized.startsWith("::ffff:169.254.")
    );
  }
  return true;
}

export async function assertSafePublicHttpUrl(rawUrl: string, config: WebExtensionConfig): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const isLocalhostName = hostname === "localhost" || hostname.endsWith(".localhost");
  if (isLocalhostName && !config.security.allowLocalhost) {
    throw new Error("Localhost URLs are blocked by configuration");
  }

  const directIpKind = net.isIP(hostname);
  const addresses = directIpKind ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateIp(address) && !config.security.allowPrivateNetworks) {
      throw new Error(`URL resolves to blocked private/local address: ${address}`);
    }
  }

  return url;
}
