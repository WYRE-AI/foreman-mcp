/**
 * Shared types for the Foreman MCP server.
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type { Tool, CallToolResult };

/** Credentials used to authenticate against the Foreman REST API. */
export interface ForemanCredentials {
  username: string;
  token: string;
}

/** One Foreman REST endpoint exposed as one MCP tool. */
export interface ForemanEndpoint {
  toolName: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path template using `:param` placeholders. */
  path: string;
  /** Optional request body key wrapping resource fields, e.g. `host`. */
  resourceKey?: string;
  tier: "read" | "write" | "admin";
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}
