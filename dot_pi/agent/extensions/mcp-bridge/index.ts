import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type McpJsonConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

type McpServerConfig = {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

type DiscoveredServer = {
  id: string;
  source: string;
  config: McpServerConfig;
};

type OAuthStore = {
  servers?: Record<string, OAuthServerStore>;
};

type OAuthServerStore = {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
};

type McpConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  registeredToolNames: string[];
};

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "mcp-oauth.json");
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 33339;
const CALLBACK_PATH = "/callback";
const CALLBACK_URL = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

class FileOAuthClientProvider {
  constructor(
    private readonly serverId: string,
    private readonly store: OAuthStore,
    private readonly save: () => Promise<void>,
    private readonly onRedirect: (url: URL) => void,
  ) {}

  get redirectUrl() {
    return CALLBACK_URL;
  }

  get clientMetadata() {
    return {
      client_name: "Pi MCP Bridge",
      redirect_uris: [CALLBACK_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    return this.getServerStore().clientInformation;
  }

  async saveClientInformation(clientInformation: unknown) {
    this.getServerStore().clientInformation = clientInformation;
    await this.save();
  }

  tokens() {
    return this.getServerStore().tokens;
  }

  async saveTokens(tokens: unknown) {
    this.getServerStore().tokens = tokens;
    await this.save();
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string) {
    this.getServerStore().codeVerifier = codeVerifier;
    await this.save();
  }

  codeVerifier() {
    const codeVerifier = this.getServerStore().codeVerifier;
    if (!codeVerifier) throw new Error(`No saved code verifier for MCP server ${this.serverId}`);
    return codeVerifier;
  }

  private getServerStore(): OAuthServerStore {
    this.store.servers ??= {};
    this.store.servers[this.serverId] ??= {};
    return this.store.servers[this.serverId]!;
  }
}

export default async function (pi: ExtensionAPI) {
  const oauthStore = await loadOAuthStore();
  const discoveredServers = await discoverServers(process.cwd());
  const connections = new Map<string, McpConnection>();
  const registeredTools = new Set<string>();
  const toolToServer = new Map<string, { serverId: string; remoteToolName: string }>();

  if (discoveredServers.length === 0) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("MCP bridge: no MCP servers found (.mcp.json or Claude Notion plugin).", "info");
    });
    return;
  }

  pi.registerCommand("mcp-status", {
    description: "Show discovered MCP servers and connection state",
    handler: async (_args, ctx) => {
      const lines = discoveredServers.map((server) => {
        const connected = connections.has(server.id) ? "connected" : "disconnected";
        const type = server.config.type ?? "unknown";
        const target = server.config.url ?? server.config.command ?? "(unknown target)";
        return `${server.id}: ${connected} | ${type} | ${target} | source=${server.source}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("mcp-login", {
    description: "Authenticate an MCP server that requires OAuth. Usage: /mcp-login <server>",
    handler: async (args, ctx) => {
      const serverId = resolveServerId(args, discoveredServers);
      if (!serverId) {
        ctx.ui.notify(
          `Usage: /mcp-login <server>. Available: ${discoveredServers.map((s) => s.id).join(", ")}`,
          "error",
        );
        return;
      }

      try {
        await connectServer(serverId, true, ctx);
        await registerAvailableToolSurfaceForServer(serverId);
        ctx.ui.notify(`MCP login succeeded for ${serverId}.`, "info");
      } catch (error) {
        ctx.ui.notify(formatError(error), "error");
      }
    },
  });

  pi.registerCommand("mcp-login-complete", {
    description: "Complete OAuth login manually. Usage: /mcp-login-complete <server> <callback-url-or-code>",
    handler: async (args, ctx) => {
      const parsed = parseManualLoginArgs(args);
      if (!parsed) {
        ctx.ui.notify(
          "Usage: /mcp-login-complete <server> <callback-url-or-code>",
          "error",
        );
        return;
      }

      const serverId = resolveServerId(parsed.serverId, discoveredServers);
      if (!serverId) {
        ctx.ui.notify(
          `Unknown MCP server: ${parsed.serverId}. Available: ${discoveredServers.map((s) => s.id).join(", ")}`,
          "error",
        );
        return;
      }

      try {
        await completeManualLogin(serverId, parsed.code);
        await registerAvailableToolSurfaceForServer(serverId);
        ctx.ui.notify(`MCP login succeeded for ${serverId}.`, "info");
      } catch (error) {
        ctx.ui.notify(formatError(error), "error");
      }
    },
  });

  for (const server of discoveredServers) {
    if (server.config.type === "http" && shouldUseGatewayTool(server)) {
      registerGatewayToolForServer(server.id);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const eagerServerIds = discoveredServers
      .filter((server) => server.config.type === "http" && !shouldUseGatewayTool(server))
      .map((server) => server.id);

    for (const serverId of eagerServerIds) {
      try {
        await connectServer(serverId, false, ctx);
        await registerToolsForServer(serverId);
      } catch (error) {
        const message = formatError(error);
        if (message.includes("/mcp-login")) {
          ctx.ui.notify(message, "info");
        } else {
          ctx.ui.notify(message, "error");
        }
      }
    }
  });

  function registerGatewayToolForServer(serverId: string) {
    const server = getServer(serverId);
    const localToolName = makeLocalToolName(server.id, "gateway");
    if (registeredTools.has(localToolName)) return;

    registeredTools.add(localToolName);

    pi.registerTool({
      name: localToolName,
      label: `${server.id}:gateway`,
      description: `Compact lazy MCP gateway for ${server.id}. Use action=list_tools first to discover remote tools and schemas, then action=call_tool with a returned toolName and arguments. Source: ${server.source}`,
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list_tools"),
          Type.Literal("call_tool"),
        ], { description: "list_tools discovers remote tools; call_tool invokes one remote tool." }),
        toolName: Type.Optional(Type.String({ description: "Remote MCP tool name. Required for call_tool." })),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arguments object for the remote MCP tool." })),
      }),
      async execute(_toolCallId, params) {
        const action = (params as { action?: string }).action;
        const connection = await connectServer(server.id, false);

        if (action === "list_tools") {
          const listResult = await connection.client.listTools();
          const tools = listResult.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: normalizeToolSchema(tool.inputSchema),
          }));

          return {
            content: [{ type: "text", text: JSON.stringify({ serverId: server.id, tools }, null, 2) }],
            details: { serverId: server.id, tools },
          };
        }

        if (action === "call_tool") {
          const toolName = (params as { toolName?: string }).toolName;
          if (!toolName) throw new Error("toolName is required when action is call_tool");

          const result = await connection.client.callTool({
            name: toolName,
            arguments: ((params as { arguments?: Record<string, unknown> }).arguments ?? {}),
          });

          return convertToolResult(server.id, toolName, result);
        }

        throw new Error(`Unknown MCP gateway action: ${String(action)}`);
      },
    });
  }

  async function registerAvailableToolSurfaceForServer(serverId: string) {
    const server = getServer(serverId);
    if (shouldUseGatewayTool(server)) {
      registerGatewayToolForServer(serverId);
      return;
    }

    await registerToolsForServer(serverId);
  }

  async function registerToolsForServer(serverId: string) {
    const server = getServer(serverId);
    const connection = await connectServer(serverId, false);
    const listResult = await connection.client.listTools();

    for (const tool of listResult.tools) {
      const localToolName = makeLocalToolName(server.id, tool.name);
      if (registeredTools.has(localToolName)) continue;

      registeredTools.add(localToolName);
      toolToServer.set(localToolName, { serverId, remoteToolName: tool.name });
      connection.registeredToolNames.push(localToolName);

      pi.registerTool({
        name: localToolName,
        label: `${server.id}:${tool.name}`,
        description: `${tool.description || `MCP tool ${tool.name}`}\n\nSource: ${server.source}`,
        parameters: normalizeToolSchema(tool.inputSchema),
        async execute(_toolCallId, params) {
          const mapping = toolToServer.get(localToolName);
          if (!mapping) throw new Error(`Missing MCP tool mapping for ${localToolName}`);

          const liveConnection = await connectServer(mapping.serverId, false);
          const result = await liveConnection.client.callTool({
            name: mapping.remoteToolName,
            arguments: params as Record<string, unknown>,
          });

          return convertToolResult(server.id, mapping.remoteToolName, result);
        },
      });
    }
  }

  async function connectServer(serverId: string, interactiveAuth: boolean, ctx?: { ui?: { notify(message: string, level?: "info" | "warning" | "error"): void } }) {
    const existing = connections.get(serverId);
    if (existing) return existing;

    const server = getServer(serverId);
    if (server.config.type !== "http" || !server.config.url) {
      throw new Error(`MCP bridge currently supports only HTTP servers. ${serverId} is ${JSON.stringify(server.config)}`);
    }

    const client = new Client(
      { name: "pi-mcp-bridge", version: "0.1.0" },
      { capabilities: {} },
    );

    const authProvider = new FileOAuthClientProvider(serverId, oauthStore, saveOAuthStoreBound, (url) => {
      ctx?.ui?.notify(`Open browser for ${serverId} login...`, "info");
      tryOpenBrowser(url);
    });

    const transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
      authProvider: authProvider as any,
    });

    try {
      await client.connect(transport);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        if (!interactiveAuth) {
          throw new Error(`MCP server ${serverId} requires login. Run /mcp-login ${serverId}`);
        }

        const authCode = await runInteractiveLogin(serverId, transport, ctx);
        await transport.finishAuth(authCode);
        await client.connect(transport);
      } else {
        throw error;
      }
    }

    const connection: McpConnection = {
      client,
      transport,
      registeredToolNames: [],
    };
    connections.set(serverId, connection);
    return connection;
  }

  async function runInteractiveLogin(serverId: string, transport: StreamableHTTPClientTransport, ctx?: { ui?: { notify(message: string, level?: "info" | "warning" | "error"): void } }) {
    ctx?.ui?.notify(`Waiting for ${serverId} OAuth callback on ${CALLBACK_URL}`, "info");
    ctx?.ui?.notify(
      `If the browser fails to redirect, copy the full callback URL and run: /mcp-login-complete ${serverId} <callback-url>`,
      "info",
    );
    const authCodePromise = waitForOAuthCallback();
    const authCode = await authCodePromise;
    ctx?.ui?.notify(`Received OAuth callback for ${serverId}`, "info");
    return authCode;
  }

  async function completeManualLogin(serverId: string, code: string) {
    const server = getServer(serverId);
    if (server.config.type !== "http" || !server.config.url) {
      throw new Error(`MCP bridge currently supports only HTTP servers. ${serverId} is ${JSON.stringify(server.config)}`);
    }

    const client = new Client(
      { name: "pi-mcp-bridge", version: "0.1.0" },
      { capabilities: {} },
    );

    const authProvider = new FileOAuthClientProvider(serverId, oauthStore, saveOAuthStoreBound, () => {});
    const transport = new StreamableHTTPClientTransport(new URL(server.config.url), {
      authProvider: authProvider as any,
    });

    await transport.finishAuth(code);
    await client.connect(transport);

    connections.set(serverId, {
      client,
      transport,
      registeredToolNames: [],
    });
  }

  function getServer(serverId: string) {
    const server = discoveredServers.find((item) => item.id === serverId);
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`);
    return server;
  }

  async function saveOAuthStoreBound() {
    await saveOAuthStore(oauthStore);
  }
}

function resolveServerId(args: string | undefined, servers: DiscoveredServer[]) {
  const trimmed = args?.trim();
  if (!trimmed) return servers.length === 1 ? servers[0]?.id : undefined;
  return servers.find((server) => server.id === trimmed)?.id;
}

function parseManualLoginArgs(args: string | undefined) {
  const trimmed = args?.trim();
  if (!trimmed) return undefined;

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return undefined;

  const serverId = trimmed.slice(0, firstSpace).trim();
  const rawCode = trimmed.slice(firstSpace + 1).trim();
  if (!serverId || !rawCode) return undefined;

  return {
    serverId,
    code: extractOAuthCode(rawCode),
  };
}

function extractOAuthCode(value: string) {
  try {
    const url = new URL(value);
    return url.searchParams.get("code") ?? value;
  } catch {
    return value;
  }
}

async function discoverServers(cwd: string): Promise<DiscoveredServer[]> {
  const servers = new Map<string, DiscoveredServer>();

  const projectMcpPath = await findUp(cwd, ".mcp.json");
  const projectMcp = projectMcpPath ? await readJsonFile<McpJsonConfig>(projectMcpPath) : undefined;
  for (const [name, config] of Object.entries(projectMcp?.mcpServers ?? {})) {
    servers.set(name, {
      id: name,
      source: projectMcpPath!,
      config,
    });
  }

  const claudeSettingsPath = await findUp(cwd, path.join(".claude", "settings.json"));
  const claudeSettings = claudeSettingsPath
    ? await readJsonFile<{ enabledPlugins?: Record<string, boolean> }>(claudeSettingsPath)
    : undefined;
  if (claudeSettings?.enabledPlugins?.["notion@claude-plugins-official"]) {
    const notionPluginMcpPath = await findLatestClaudePluginMcpPath("Notion");
    if (notionPluginMcpPath) {
      const pluginMcp = await readJsonFile<McpJsonConfig>(notionPluginMcpPath);
      for (const [name, config] of Object.entries(pluginMcp?.mcpServers ?? {})) {
        if (!servers.has(name)) {
          servers.set(name, {
            id: name,
            source: notionPluginMcpPath,
            config,
          });
        }
      }
    }
  }

  return [...servers.values()];
}

async function findUp(startDir: string, relativePath: string): Promise<string | undefined> {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, relativePath);
    if (existsSync(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function findLatestClaudePluginMcpPath(pluginName: string) {
  const baseDir = path.join(os.homedir(), ".claude", "plugins", "cache", "claude-plugins-official", pluginName);
  if (!existsSync(baseDir)) return undefined;

  const { readdir } = await import("node:fs/promises");
  const versions = (await readdir(baseDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareSemverDesc(a, b));

  for (const version of versions) {
    const candidate = path.join(baseDir, version, ".mcp.json");
    if (existsSync(candidate)) return candidate;
  }

  return undefined;
}

function compareSemverDesc(a: string, b: string) {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const delta = (bParts[i] ?? 0) - (aParts[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function shouldUseGatewayTool(server: DiscoveredServer) {
  return server.id === "notion" || /[/\\]Notion[/\\]/.test(server.source);
}

function makeLocalToolName(serverId: string, remoteToolName: string) {
  return `mcp__${sanitizeName(serverId)}__${sanitizeName(remoteToolName)}`;
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function normalizeToolSchema(schema: unknown) {
  if (!schema || typeof schema !== "object") {
    return Type.Object({}, { additionalProperties: true });
  }

  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, Json>;
  delete copy["$schema"];
  return copy as any;
}

function convertToolResult(serverId: string, toolName: string, result: any) {
  const content: Array<{ type: "text"; text: string }> = [];

  for (const item of result.content ?? []) {
    if (item?.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      continue;
    }

    content.push({
      type: "text",
      text: JSON.stringify(item, null, 2),
    });
  }

  if (content.length === 0) {
    if (result.structuredContent !== undefined) {
      content.push({
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2),
      });
    } else {
      content.push({ type: "text", text: "(no content)" });
    }
  }

  return {
    content,
    details: {
      serverId,
      toolName,
      structuredContent: result.structuredContent,
      rawContent: result.content,
    },
    isError: Boolean(result.isError),
  };
}

async function waitForOAuthCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", CALLBACK_URL);
        if (url.pathname !== CALLBACK_PATH) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (error) {
          res.statusCode = 400;
          res.end(`OAuth failed: ${error}`);
          server.close();
          reject(new Error(`OAuth failed: ${error}`));
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.end("Missing OAuth code");
          return;
        }

        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><body><h1>Pi MCP login complete</h1><p>You can return to Pi.</p></body></html>");
        server.close();
        resolve(code);
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => undefined);
    server.on("error", reject);
  });
}

function tryOpenBrowser(url: URL) {
  const commands = [
    ["open", [url.toString()]],
    ["xdg-open", [url.toString()]],
    ["cmd", ["/c", "start", url.toString()]],
  ] as const;

  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.unref();
      return;
    } catch {
      // try next
    }
  }

  // fall back to printing URL; Pi will show it in the error/info message path
  console.log(`Open this URL to authenticate: ${url.toString()}`);
}

async function loadOAuthStore(): Promise<OAuthStore> {
  return (await readJsonFile<OAuthStore>(AUTH_FILE)) ?? {};
}

async function saveOAuthStore(store: OAuthStore) {
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify(store, null, 2));
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
