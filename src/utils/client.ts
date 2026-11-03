/**
 * Foreman REST API client.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ForemanCredentials } from "./types.js";

export const DEFAULT_BASE_URL = "https://foreman.example.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const FOREMAN_TOKEN_HEADER = "x-foreman-token";

const MAX_TOKEN_LENGTH = 512;

export function resolveBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim();
  if (!value) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid FOREMAN_BASE_URL: not a valid URL.");
  }
  const fail = (): never => {
    throw new Error("Invalid FOREMAN_BASE_URL: only https://foreman.example.com and http://localhost are allowed.");
  };
  if (url.username || url.password || url.hash) fail();
  const host = url.hostname.toLowerCase();
  const allowedHttpHosts = new Set(["127.0.0.1", "localhost"]);
  if (url.protocol === "https:") {
    if (host !== "foreman.example.com" || url.port !== "") fail();
  } else if (url.protocol === "http:") {
    if (!allowedHttpHosts.has(host)) fail();
  } else {
    fail();
  }
  return value;
}

export function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl(env.FOREMAN_BASE_URL);
}

const credentialStore = new AsyncLocalStorage<ForemanCredentials>();

export function runWithCredentials<T>(creds: ForemanCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

function isPlausibleToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

export function getCredentials(env: NodeJS.ProcessEnv = process.env): ForemanCredentials | null {
  const scoped = credentialStore.getStore();
  if (scoped) return scoped;
  if (env.AUTH_MODE === "gateway") return null;
  const username = (env.FOREMAN_USERNAME ?? "").trim();
  const token = (env.FOREMAN_TOKEN ?? "").trim();
  if (!username || !token || !isPlausibleToken(token)) return null;
  return { username, token };
}

export function resolveGatewayCredentials(
  getHeader: (name: string) => string | undefined,
): { credentials?: ForemanCredentials; error?: string } {
  const username = typeof getHeader("x-foreman-username") === "string" ? getHeader("x-foreman-username")!.trim() : "";
  const token = typeof getHeader(FOREMAN_TOKEN_HEADER) === "string" ? getHeader(FOREMAN_TOKEN_HEADER)!.trim() : "";
  if (!username || !token) {
    return { error: "Missing X-Foreman-Username or X-Foreman-Token header (gateway mode requires both)." };
  }
  if (!isPlausibleToken(token)) {
    return { error: "Invalid X-Foreman-Token header value." };
  }
  return { credentials: { username, token } };
}

function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[REDACTED]");
}

export type ClientErrorKind = "config" | "auth" | "http" | "timeout" | "network";

export interface ClientError {
  kind: ClientErrorKind;
  message: string;
}

export type ClientResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: ClientError };

export interface RequestOptions {
  timeoutMs?: number;
  credentials?: ForemanCredentials;
  baseUrl?: string;
}

export const AUTH_ERROR_MESSAGE =
  "Invalid or missing Foreman credentials. Create a Personal Access Token and provide FOREMAN_USERNAME and FOREMAN_TOKEN.";

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function executeForemanRequest(
  endpoint: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; resourceKey?: string },
  args: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<ClientResult> {
  const credentials = options.credentials ?? getCredentials();
  if (!credentials) {
    return { ok: false, error: { kind: "auth", message: AUTH_ERROR_MESSAGE } };
  }

  let url: string;
  try {
    url = options.baseUrl ? resolveBaseUrl(options.baseUrl) : getBaseUrl();
  } catch (error) {
    return { ok: false, error: { kind: "config", message: error instanceof Error ? error.message : "Invalid Foreman base URL" } };
  }

  const pathParams = endpoint.path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part, index, parts) => {
      if (parts[index - 1] === ":host_id") return encodeURIComponent(String(args.host_id ?? ""));
      if (parts[index - 1] === ":id") return encodeURIComponent(String(args.id ?? ""));
      if (parts[index - 1] === ":hostgroup_id") return encodeURIComponent(String(args.hostgroup_id ?? ""));
      if (parts[index - 1] === ":interface_id") return encodeURIComponent(String(args.interface_id ?? ""));
      if (parts[index - 1] === ":job_id") return encodeURIComponent(String(args.job_id ?? ""));
      if (parts[index - 1] === ":type") return encodeURIComponent(String(args.type ?? ""));
      if (parts[index - 1] === ":organization_id") return encodeURIComponent(String(args.organization_id ?? ""));
      if (parts[index - 1] === ":location_id") return encodeURIComponent(String(args.location_id ?? ""));
      if (parts[index - 1] === ":subnet_id") return encodeURIComponent(String(args.subnet_id ?? ""));
      if (parts[index - 1] === ":operatingsystem_id") return encodeURIComponent(String(args.operatingsystem_id ?? ""));
      if (parts[index - 1] === ":smart_proxy_id") return encodeURIComponent(String(args.smart_proxy_id ?? ""));
      if (parts[index - 1] === ":compute_resource_id") return encodeURIComponent(String(args.compute_resource_id ?? ""));
      if (parts[index - 1] === ":user_id") return encodeURIComponent(String(args.user_id ?? ""));
      if (parts[index - 1] === ":setting_id") return encodeURIComponent(String(args.setting_id ?? ""));
      if (parts[index - 1] === ":report_template_id") return encodeURIComponent(String(args.report_template_id ?? ""));
      return part;
    });
  const resolvedPath = endpoint.path.replace(/:([^:]+)(?=:)/g, (_, key: string) => {
    const value = (args[key] ?? "") as string;
    return encodeURIComponent(value);
  });

  const body = endpoint.method === "GET" || endpoint.method === "DELETE" ? undefined : endpoint.resourceKey && args[endpoint.resourceKey] === undefined ? { [endpoint.resourceKey]: args } : args;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(`${getBaseUrl()}${resolvedPath}`, {
      method: endpoint.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json,version=2",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    bodyText = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, error: { kind: "timeout", message: `Foreman API request timed out after ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.` } };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { kind: "network", message: redact(message, credentials.token) } };
  } finally {
    clearTimeout(timer);
  }

  const responseBody = tryParseJson(bodyText);
  if (!isRecord(responseBody)) {
    return { ok: false, error: { kind: "http", message: "Foreman API returned a non-JSON response." } };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { kind: "auth", message: AUTH_ERROR_MESSAGE } };
  }
  if (!response.ok) {
    const error = responseBody.error;
    const message = isRecord(error) && typeof error.message === "string"
      ? error.message
      : `Foreman API returned HTTP ${response.status}`;
    return { ok: false, error: { kind: "http", message: redact(message, credentials.token) } };
  }
  return { ok: true, data: responseBody };
}
