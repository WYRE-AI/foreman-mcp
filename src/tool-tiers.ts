import type { ForemanEndpoint } from "./utils/types.js";
import { FOREMAN_ENDPOINTS } from "./tools/registry.js";

export interface ToolTierInfo {
  tier: "read" | "write" | "admin";
  endpoint: ForemanEndpoint;
}

export const TOOL_TIERS: Record<string, ToolTierInfo> = Object.fromEntries(
  FOREMAN_ENDPOINTS.map((endpoint) => [endpoint.toolName, { tier: endpoint.tier, endpoint }]),
);

export const OPERATION_TO_TOOL: Record<string, string> = Object.fromEntries(
  FOREMAN_ENDPOINTS.map((endpoint) => [endpoint.path, endpoint.toolName]),
);
