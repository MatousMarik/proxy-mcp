/**
 * Utility functions for the proxy MCP server.
 */

import { networkInterfaces } from "node:os";

/**
 * Maximum characters for tool output to stay within MCP token limits.
 */
const MAX_RESULT_CHARS = 24000;

/**
 * Serialize data to JSON, truncating if it exceeds MCP limits.
 * For arrays: binary-search for max items that fit, append truncation notice.
 * For other values: slice the JSON string and append a notice.
 */
export function truncateResult(data: unknown, indent?: number): string {
  const full = JSON.stringify(data, null, indent);
  if (full.length <= MAX_RESULT_CHARS) return full;

  if (Array.isArray(data)) {
    let lo = 0;
    let hi = data.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (JSON.stringify(data.slice(0, mid), null, indent).length <= MAX_RESULT_CHARS - 200) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const truncated = data.slice(0, lo);
    return JSON.stringify({
      items: truncated,
      truncated: true,
      showing: lo,
      total: data.length,
      message: `Showing ${lo} of ${data.length} items. Use filter/limit params to narrow results.`,
    }, null, indent);
  }

  return full.slice(0, MAX_RESULT_CHARS - 100) + "\n... [truncated, total " + full.length + " chars]";
}

/**
 * Get the first non-loopback IPv4 address for LAN proxy instructions.
 */
export function getLocalIP(): string {
  let interfaces: ReturnType<typeof networkInterfaces>;
  try {
    interfaces = networkInterfaces();
  } catch {
    return "127.0.0.1";
  }
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Serialize headers object to a clean record, lowercasing keys.
 */
export function serializeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return result;
}

/**
 * Cap a string to maxLen characters, appending "..." if truncated.
 */
export function capString(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

/**
 * Environment variable holding the upstream proxy password.
 *
 * One credential for all upstreams. Per-provider secrets would need
 * PROXY_MCP_UPSTREAM_PASSWORD_<HOST> or similar; nothing needs that yet.
 */
const UPSTREAM_PASSWORD_ENV = "PROXY_MCP_UPSTREAM_PASSWORD";

/**
 * Replace credentials in a proxy URL with "***" for safe logging.
 *
 * Upstream proxy URLs carry credentials, and tool responses are persisted in
 * the MCP client transcript. The username is preserved on purpose: for some
 * providers it is configuration rather than a secret (Apify Proxy encodes
 * proxy group, country and sticky-session id there), and it is what makes a
 * confirmation message worth printing. See the README security section.
 *
 * Query values are redacted too: a pac+http:// URL normally carries its token
 * in the query rather than in userinfo.
 */
export function redactProxyUrl(proxyUrl: string): string {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return "<unparseable url>";
  }
  if (url.password) url.password = "***";
  for (const key of [...url.searchParams.keys()]) {
    url.searchParams.set(key, "***");
  }
  return url.toString();
}

/**
 * Fill in the upstream password from the environment when the caller supplied
 * a username but no password, so a credential need not appear in the tool call.
 *
 * The value can only ever land in the password slot, which is the one field
 * redactProxyUrl() masks — a substituted secret cannot be echoed back through
 * the username, host, path or query. The value is percent-encoded, so a
 * password containing "@" or "/" cannot re-point the upstream at another host.
 *
 * A URL with no username, or one that already carries a password, is returned
 * untouched; so is any URL when the variable is unset.
 */
export function mergeUpstreamPassword(
  proxyUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const password = env[UPSTREAM_PASSWORD_ENV];
  if (!password) return proxyUrl;

  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return proxyUrl; // let the caller's own parsing report the problem
  }
  if (!url.username || url.password) return proxyUrl;

  // encodeURIComponent, not the raw value: the password setter escapes "@" and
  // "/" but leaves "%" alone, and mockttp reads the credential back through
  // url.parse().auth, which decodeURIComponent()s it. A raw "%" therefore makes
  // that decode throw, and a raw "%20" silently decodes to a space. Encoding
  // first is lossless — the setter escapes nothing encodeURIComponent leaves.
  url.password = encodeURIComponent(password);
  return url.toString();
}

/**
 * Which credential a resolved upstream URL ended up using, for the tool
 * response.
 *
 * A caller that omits the password when the server has no
 * PROXY_MCP_UPSTREAM_PASSWORD otherwise gets a plain "success" and finds out
 * only later, as unexplained 407s on unrelated requests. "none" says so at the
 * call that can still be corrected.
 */
export function upstreamPasswordSource(
  original: string,
  resolved: string,
): "env" | "url" | "none" {
  if (resolved !== original) return "env";
  try {
    return new URL(original).password ? "url" : "none";
  } catch {
    return "none";
  }
}
