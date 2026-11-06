import { FOREMAN_ENDPOINTS } from "./tools/registry.js";
import type { ForemanEndpoint } from "./utils/types.js";

export const ALL_TIERS = ["read", "write", "admin"] as const;
export type ToolTier = (typeof ALL_TIERS)[number];
export const DEFAULT_TIERS: readonly ToolTier[] = ["read"];

export function parseEnabledTiers(raw: string | undefined): Set<ToolTier> {
  const tokens = (raw ?? "").split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return new Set(DEFAULT_TIERS);
  const enabled = new Set<ToolTier>();
  for (const token of tokens) {
    if (!ALL_TIERS.includes(token as ToolTier)) {
      throw new Error(`Invalid FOREMAN_TOOL_TIERS value "${token}". Allowed: ${ALL_TIERS.join(", ")} (comma separated).`);
    }
    enabled.add(token as ToolTier);
  }
  return enabled;
}

export function getEnabledTiers(env: NodeJS.ProcessEnv = process.env): Set<ToolTier> {
  return parseEnabledTiers(env.FOREMAN_TOOL_TIERS);
}

export function getEndpoint(toolName: string): ForemanEndpoint | undefined {
  return FOREMAN_ENDPOINTS.find((endpoint) => endpoint.toolName === toolName);
}

export function isToolEnabled(toolName: string, enabled: ReadonlySet<ToolTier>): boolean {
  const endpoint = getEndpoint(toolName);
  return endpoint !== undefined && enabled.has(endpoint.tier);
}
