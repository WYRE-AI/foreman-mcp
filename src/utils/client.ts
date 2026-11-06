/**
 * Foreman REST API client.
 *
 * Auth is HTTP Basic with a username and a Personal Access Token. There is no
 * session/ticket exchange, so there is no credential cache and no re-auth: a
 * 401/403 is reported once and never retried.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent } from "undici";
import type { ClientResult, ForemanCredentials, ForemanEndpoint } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const USERNAME_HEADER = "x-foreman-username";
export const FOREMAN_TOKEN_HEADER = "x-foreman-token";
export const MAX_MESSAGE_CHARS = 2000;

const MAX_TOKEN_LENGTH = 512;

/** Thrown for invalid tool input; surfaced to the model as a tool error. */
export class InputError extends Error {}

// ---------------------------------------------------------------------------
// Base URL
// ---------------------------------------------------------------------------

/**
 * Validate FOREMAN_BASE_URL. It is required (there is no default). The host is
 * operator-configured, so any https host is allowed, including private IPs and
 * non-default ports. http is only allowed for localhost / 127.0.0.1 (tests).
 * No userinfo, query or fragment. Trailing slashes are removed.
 */
export function resolveBaseUrl(raw?: string): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("FOREMAN_BASE_URL is required (for example https://foreman.example.com).");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid FOREMAN_BASE_URL: not a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("Invalid FOREMAN_BASE_URL: userinfo is not allowed.");
  }
  if (url.hash || url.search) {
    throw new Error("Invalid FOREMAN_BASE_URL: query strings and fragments are not allowed.");
  }
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost") {
      throw new Error("Invalid FOREMAN_BASE_URL: http is only allowed for localhost.");
    }
  } else if (url.protocol !== "https:") {
    throw new Error("Invalid FOREMAN_BASE_URL: only https is allowed except http://127.0.0.1 and http://localhost.");
  }
  if (!url.hostname) throw new Error("Invalid FOREMAN_BASE_URL: hostname is required.");
  return value.replace(/\/+$/, "");
}

export function getBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBaseUrl(env.FOREMAN_BASE_URL);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const credentialStore = new AsyncLocalStorage<ForemanCredentials>();

/** Run `fn` with per-request credentials (gateway mode). */
export function runWithCredentials<T>(creds: ForemanCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

export function isGatewayAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AUTH_MODE ?? "").trim() === "gateway";
}

function isPlausibleToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A Basic-auth user id cannot contain ":" and must be printable. */
function isPlausibleUsername(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes(":") && !hasControlChars(value);
}

/**
 * Resolve credentials. When a header getter is supplied (gateway mode) the
 * username and token come only from X-Foreman-Username / X-Foreman-Token and
 * the environment credentials are never used. Otherwise they come from
 * FOREMAN_USERNAME / FOREMAN_TOKEN. The base URL always comes from the
 * operator's FOREMAN_BASE_URL, never from a request.
 */
export function getCredentials(
  env: NodeJS.ProcessEnv = process.env,
  getHeader?: (name: string) => string | undefined,
): ForemanCredentials | { error: string } {
  let baseUrl: string;
  try {
    baseUrl = getBaseUrl(env);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (getHeader) {
    const username = (getHeader(USERNAME_HEADER) ?? "").trim();
    const token = (getHeader(FOREMAN_TOKEN_HEADER) ?? "").trim();
    if (!username || !token) {
      return { error: "Missing X-Foreman-Username or X-Foreman-Token header (gateway mode requires both)." };
    }
    if (!isPlausibleUsername(username)) return { error: "Invalid X-Foreman-Username header value." };
    if (!isPlausibleToken(token)) return { error: "Invalid X-Foreman-Token header value." };
    return { username, token, baseUrl };
  }
  const username = (env.FOREMAN_USERNAME ?? "").trim();
  const token = (env.FOREMAN_TOKEN ?? "").trim();
  if (!username || !token) return { error: AUTH_ERROR_MESSAGE };
  if (!isPlausibleUsername(username) || !isPlausibleToken(token)) {
    return { error: "FOREMAN_USERNAME or FOREMAN_TOKEN contains invalid characters." };
  }
  return { username, token, baseUrl };
}

/**
 * The credentials a tool call must use. Gateway mode (AUTH_MODE=gateway) only
 * ever uses the per-request credentials bound by the HTTP layer; it never
 * falls back to FOREMAN_USERNAME / FOREMAN_TOKEN.
 */
export function resolveRequestCredentials(env: NodeJS.ProcessEnv = process.env): ForemanCredentials | { error: string } {
  const scoped = credentialStore.getStore();
  if (scoped) return scoped;
  // SECURITY-REVIEW: gateway mode never falls back to environment credentials.
  if (isGatewayAuth(env)) return { error: "Missing per-request credentials (gateway mode)." };
  return getCredentials(env);
}

export const AUTH_ERROR_MESSAGE =
  "Invalid or missing Foreman credentials. Create a Personal Access Token and provide FOREMAN_USERNAME and FOREMAN_TOKEN.";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY =
  /(^|[_-])(pass|passwd|password|passphrase|pwd)([_-]|$)|password|passwd|passphrase|root_pass|secret|token|api[_-]?key|authorization|private[_-]?key|credential|(^|[_-])key([_-]|$)/i;
/** camelCase forms (apiKey, sshKey); case-sensitive so "monkey"/"keyboard" are untouched. */
const SENSITIVE_CAMEL_KEY = /[a-z0-9]Key$/;

function isSensitiveName(name: string): boolean {
  return SENSITIVE_KEY.test(name) || SENSITIVE_CAMEL_KEY.test(name);
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

/** Read a response body as text, refusing more than MAX_RESPONSE_BYTES. */
async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const TLS_CERT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  let detail = error.message;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    const causeMessage = (cause as { message?: unknown }).message;
    const parts = [typeof code === "string" ? code : "", typeof causeMessage === "string" ? causeMessage : ""].filter(Boolean);
    if (parts.length > 0) detail += ` (${parts.join(": ")})`;
    if (typeof code === "string" && TLS_CERT_CODES.has(code)) {
      detail += " Hint: set FOREMAN_CA_CERT_FILE to a PEM file containing your Foreman CA certificate.";
    }
  }
  return detail;
}

/** Every form the credential may take in a header, URL, or echoed error. */
function derivedSecrets(creds: ForemanCredentials): string[] {
  const token = creds.token;
  const pair = `${creds.username}:${token}`;
  return [
    token,
    pair,
    Buffer.from(pair).toString("base64"),
    Buffer.from(token).toString("base64"),
    encodeURIComponent(token),
    createHash("sha256").update(token).digest("hex"),
    createHash("md5").update(token).digest("hex"),
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/(authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+(?:\s+[^\s,;&}]+)?)/gi, "$1[REDACTED]")
    .replace(
      /((?:password|passwd|passphrase|root_pass|secret|token|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}"']+)/gi,
      "$1[REDACTED]",
    );
  // Longest first so a long derived form is not left half-redacted by a shorter one.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Redact first, then truncate, so a secret split by the cut is never half-shown. */
export function redactAndTruncate(text: string, secrets: string[]): string {
  return redactSecrets(text, secrets).slice(0, MAX_MESSAGE_CHARS);
}

/** Redact every string in a (JSON) value, and the value of any sensitive-looking key. */
export function redactData(data: unknown, secrets: string[]): unknown {
  if (typeof data === "string") return redactSecrets(data, secrets);
  if (Array.isArray(data)) return data.map((item) => redactData(item, secrets));
  if (typeof data === "object" && data !== null) {
    const rawName = (data as Record<string, unknown>).name;
    const nameSensitive = typeof rawName === "string" && isSensitiveName(rawName);
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => {
        const safeKey = redactSecrets(key, secrets);
        if (isSensitiveName(key) && value !== null && typeof value !== "boolean") {
          return [safeKey, "[REDACTED]"];
        }
        // name/value pairs (settings, host and host group parameters).
        if (nameSensitive && (key === "value" || key === "default") && value !== null && typeof value !== "boolean") {
          return [safeKey, "[REDACTED]"];
        }
        return [safeKey, redactData(value, secrets)];
      }),
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

const agentCache = new Map<string, Agent>();

/** One undici Agent per CA path, reused across calls. TLS verification stays on. */
export function getAgent(env: NodeJS.ProcessEnv = process.env): Agent | undefined {
  const certPath = (env.FOREMAN_CA_CERT_FILE ?? "").trim();
  if (!certPath) return undefined;
  const cached = agentCache.get(certPath);
  if (cached) return cached;
  const agent = new Agent({ connect: { ca: readFileSync(certPath, "utf8") } });
  agentCache.set(certPath, agent);
  return agent;
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

const PLACEHOLDER = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/** Names of the `:param` placeholders in a path template. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/**
 * Substitute every `:param` placeholder in the RAW template in one pass, so
 * `:id` can never clobber part of `:host_id`. Each value must be a string or
 * number and is validated (not empty, not "." or "..", no "/", "\" or control
 * characters) and then percent-encoded.
 */
export function buildPath(template: string, args: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const raw = Object.hasOwn(args, name) ? args[name] : undefined;
    if (raw === undefined || raw === null) {
      throw new InputError(`Missing required path parameter "${name}".`);
    }
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new InputError(`Invalid value for path parameter "${name}": must be a string or number.`);
    }
    const value = String(raw);
    if (value.trim() === "" || value === "." || value === "..") {
      throw new InputError(`Invalid value for path parameter "${name}": must not be empty, "." or "..".`);
    }
    if (/[/\\]/.test(value)) {
      throw new InputError(`Invalid value for path parameter "${name}": must not contain "/" or "\\".`);
    }
    if (hasControlChars(value)) {
      throw new InputError(`Invalid value for path parameter "${name}": must not contain control characters.`);
    }
    return encodeURIComponent(value);
  });
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep copy that drops prototype-pollution keys. */
export function sanitizeData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeData);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = sanitizeData(item);
    }
    return out;
  }
  return value;
}

export interface BuiltRequest {
  url: string;
  method: ForemanEndpoint["method"];
  body?: string;
}

/**
 * Build the URL and body from the declared arguments. Path parameters go only
 * into the path. The remaining arguments are the query string for GET, and the
 * JSON body for POST/PUT/DELETE (omitted when empty for DELETE).
 */
export function buildRequest(
  endpoint: Pick<ForemanEndpoint, "method" | "path">,
  args: Record<string, unknown>,
  baseUrl: string,
): BuiltRequest {
  const pathNames = new Set(pathParamNames(endpoint.path));
  const path = buildPath(endpoint.path, args);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (pathNames.has(key) || FORBIDDEN_KEYS.has(key) || value === undefined || value === null) continue;
    rest[key] = sanitizeData(value);
  }
  if (endpoint.method === "GET") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        query.set(key, String(value));
      } else {
        throw new InputError(`Invalid input "${key}": expected a scalar value.`);
      }
    }
    const qs = query.toString();
    return { url: `${baseUrl}${path}${qs ? `?${qs}` : ""}`, method: "GET" };
  }
  const hasBody = endpoint.method !== "DELETE" || Object.keys(rest).length > 0;
  return { url: `${baseUrl}${path}`, method: endpoint.method, body: hasBody ? JSON.stringify(rest) : undefined };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull a human-readable message out of the shapes Foreman uses for errors. */
function upstreamMessage(body: unknown, text: string): string {
  if (isRecord(body)) {
    const error = body.error;
    if (typeof error === "string") return error;
    if (isRecord(error)) {
      if (Array.isArray(error.full_messages) && error.full_messages.every((m) => typeof m === "string") && error.full_messages.length > 0) {
        return error.full_messages.join("; ");
      }
      if (typeof error.message === "string") return error.message;
    }
    if (typeof body.message === "string") return body.message;
    return JSON.stringify(body);
  }
  return typeof body === "string" ? body : text;
}

export interface RequestOptions {
  timeoutMs?: number;
  credentials?: ForemanCredentials;
}

/**
 * Execute one endpoint. `args` must already be validated against the tool's
 * declared schema. Exactly one upstream request is made: a 401/403 is returned
 * as an auth error and never retried.
 */
export async function executeForemanRequest(
  endpoint: Pick<ForemanEndpoint, "method" | "path">,
  args: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<ClientResult> {
  let credentials = options.credentials;
  if (!credentials) {
    const resolved = resolveRequestCredentials();
    if ("error" in resolved) {
      return { ok: false, error: { kind: resolved.error.includes("FOREMAN_BASE_URL") ? "config" : "auth", message: resolved.error } };
    }
    credentials = resolved;
  }
  const secrets = derivedSecrets(credentials);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let request: BuiltRequest;
  try {
    request = buildRequest(endpoint, args, credentials.baseUrl);
  } catch (error) {
    if (error instanceof InputError) return { ok: false, error: { kind: "input", message: error.message } };
    throw error;
  }

  let dispatcher: Agent | undefined;
  try {
    dispatcher = getAgent();
  } catch {
    return { ok: false, error: { kind: "config", message: "Unable to read FOREMAN_CA_CERT_FILE." } };
  }

  let response: Response;
  let bodyText: string;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json,version=2",
      },
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      dispatcher: dispatcher as never,
    } as RequestInit);
    bodyText = await readCappedText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      return { ok: false, error: { kind: "http", message: `Foreman API response is too large (limit ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB); narrow the request with filters or pagination.` } };
    }
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: { kind: "timeout", message: `Foreman API request timed out after ${Math.round(timeoutMs / 1000)}s.` } };
    }
    const detail = describeNetworkError(error);
    return { ok: false, error: { kind: "network", message: redactAndTruncate(`Foreman API request failed: ${detail}`, secrets) } };
  }

  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: { kind: "http", message: `Foreman returned an unexpected redirect (status ${response.status}); redirects are not followed.` } };
  }
  if (response.status === 401 || response.status === 403) {
    // Basic/PAT auth: there is nothing to refresh, so no retry.
    return { ok: false, error: { kind: "auth", message: AUTH_ERROR_MESSAGE } };
  }

  const parsed = bodyText.trim() === "" ? ({ ok: true, value: {} } as const) : tryParseJson(bodyText);
  const data = parsed.ok ? parsed.value : bodyText;

  if (!response.ok) {
    const detail = upstreamMessage(data, bodyText);
    return { ok: false, error: { kind: "http", message: redactAndTruncate(`Foreman API returned HTTP ${response.status}: ${detail}`, secrets) } };
  }
  return { ok: true, data: redactData(data, secrets) };
}
