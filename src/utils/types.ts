/**
 * Shared types for the Foreman MCP server.
 */

import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type { Tool, CallToolResult };

/** Credentials used to authenticate against the Foreman REST API. */
export interface ForemanCredentials {
  username: string;
  token: string;
  /** Validated Foreman base URL (operator-configured; never taken from a request). */
  baseUrl: string;
}

/** JSON-schema fragment for one declared tool input. */
export interface ParamSchema {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  items?: { type: string };
}

/** One Foreman REST endpoint exposed as one MCP tool. */
export interface ForemanEndpoint {
  toolName: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path template using `:param` placeholders. */
  path: string;
  tier: "read" | "write" | "admin";
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ParamSchema>;
    required: string[];
    additionalProperties: false;
  };
}

export type ClientErrorKind = "config" | "auth" | "input" | "http" | "timeout" | "network";

export interface ClientError {
  kind: ClientErrorKind;
  message: string;
}

export type ClientResult =
  | { ok: true; data: unknown }
  | { ok: false; error: ClientError };
