import type { CallToolResult } from "./types.js";
import { executeForemanRequest, getCredentials } from "./client.js";
import { getEnabledTiers, isToolEnabled, getEndpoint } from "../tiers.js";
import { logger } from "./logger.js";

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function buildUrl(endpointPath: string, args: Record<string, unknown>): string {
  const pattern = endpointPath.replace(/^\//, "");
  const parts = pattern.split("/");
  const values = new Set<string>();
  for (const part of parts) {
    if (part.startsWith(":")) values.add(part.slice(1));
  }
  let resolved = endpointPath;
  for (const value of values) {
    const replacement = encodeURIComponent(String(args[value] ?? ""));
    resolved = resolved.replace(`:${value}`, replacement);
  }
  return resolved;
}

function buildBody(endpoint: { resourceKey?: string }, args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!endpoint.resourceKey) return args;
  return { [endpoint.resourceKey]: args };
}

export async function callForemanTool(
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<CallToolResult> {
  const endpoint = getEndpoint(name);
  if (!endpoint) return errorResult(`Unknown tool: ${name}`);

  let enabledTiers;
  try {
    enabledTiers = getEnabledTiers();
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "Invalid FOREMAN_TOOL_TIERS");
  }
  if (!isToolEnabled(name, enabledTiers)) {
    const tier = endpoint.tier;
    return errorResult(`Tool ${name} requires the "${tier}" tier, which is not enabled. Enabled tiers: ${[...enabledTiers].join(", ")}. Set FOREMAN_TOOL_TIERS to enable it.`);
  }

  const args = rawArgs ?? {};
  const properties = endpoint.inputSchema.properties ?? {};
  const unknown = Object.keys(args).filter((key: string) => !(key in properties));
  if (unknown.length > 0) {
    return errorResult(`Unknown argument(s) for ${name}: ${unknown.join(", ")}. Allowed: ${Object.keys(properties).join(", ") || "(none)"}.`);
  }
  const required = endpoint.inputSchema.required ?? [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return errorResult(`Missing required argument(s) for ${name}: ${missing.join(", ")}.`);
  }

  logger.debug("Executing Foreman operation", { tool: name, method: endpoint.method, path: endpoint.path });
  const result = await executeForemanRequest(
    { method: endpoint.method, path: buildUrl(endpoint.path, args), resourceKey: endpoint.resourceKey },
    args,
    { credentials: getCredentials() ?? undefined },
  );
  if (!result.ok) return errorResult(result.error.message);

  const payload = result.data;
  if (Array.isArray(payload.results)) {
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
  }
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
}
