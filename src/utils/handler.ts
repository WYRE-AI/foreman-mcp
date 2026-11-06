import type { CallToolResult, ForemanEndpoint, ParamSchema } from "./types.js";
import { executeForemanRequest, pathParamNames, resolveRequestCredentials } from "./client.js";
import { getEnabledTiers, isToolEnabled, getEndpoint } from "../tiers.js";
import { logger } from "./logger.js";

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function typeMatches(spec: ParamSchema, value: unknown): boolean {
  switch (spec.type) {
    case "string":
      return typeof value === "string" && (!spec.enum || spec.enum.includes(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/**
 * Check the arguments against the tool's declared inputSchema. Undeclared
 * arguments (including `__proto__` / `constructor`) are rejected and nothing
 * is sent upstream. Returns an error string, or the declared arguments.
 */
export function validateArgs(
  endpoint: ForemanEndpoint,
  args: Record<string, unknown>,
): { error: string } | { args: Record<string, unknown> } {
  const properties = endpoint.inputSchema.properties;
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(properties, key));
  if (unknown.length > 0) {
    return { error: `Unknown argument(s) for ${endpoint.toolName}: ${unknown.join(", ")}. Allowed: ${Object.keys(properties).join(", ") || "(none)"}.` };
  }
  const missing = endpoint.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return { error: `Missing required argument(s) for ${endpoint.toolName}: ${missing.join(", ")}.` };
  }
  const pathNames = pathParamNames(endpoint.path);
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = Object.hasOwn(args, key) ? args[key] : undefined;
    if (value === undefined || value === null) continue;
    // Path-parameter ids may be given as a string or a number.
    const ok = typeMatches(spec, value) || (pathNames.includes(key) && spec.type === "number" && typeof value === "string" && /^\d+$/.test(value));
    if (!ok) {
      const expected = spec.enum ? `one of ${spec.enum.join(", ")}` : `a ${spec.type}`;
      return { error: `Invalid argument "${key}" for ${endpoint.toolName}: expected ${expected}.` };
    }
    out[key] = value;
  }
  return { args: out };
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
    return errorResult(`Tool ${name} requires the "${endpoint.tier}" tier, which is not enabled. Enabled tiers: ${[...enabledTiers].join(", ")}. Set FOREMAN_TOOL_TIERS to enable it.`);
  }

  // Credentials (and the required FOREMAN_BASE_URL) are resolved per call.
  // Gateway mode only ever sees per-request credentials, never the environment.
  const credentials = resolveRequestCredentials();
  if ("error" in credentials) return errorResult(`Error: ${credentials.error}`);

  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return errorResult(`Invalid arguments for ${name}: expected an object.`);
  }
  const validated = validateArgs(endpoint, rawArgs);
  if ("error" in validated) return errorResult(validated.error);

  logger.debug("Executing Foreman operation", { tool: name, method: endpoint.method, path: endpoint.path });
  const result = await executeForemanRequest(endpoint, validated.args, { credentials });
  if (!result.ok) return errorResult(`Error: ${result.error.message}`);
  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? null);
  return { content: [{ type: "text", text }], isError: false };
}
