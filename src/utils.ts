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
 * Replace the password in a proxy URL with "***" for safe logging.
 *
 * Upstream proxy URLs carry credentials, and tool responses are persisted in
 * the MCP client transcript. The username is preserved on purpose: for some
 * providers it is configuration rather than a secret (Apify Proxy encodes
 * proxy group, country and sticky-session id there), and it is what makes a
 * confirmation message worth printing.
 */
export function redactProxyUrl(proxyUrl: string): string {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    return "<unparseable url>";
  }
  if (!url.password) return proxyUrl;

  // Splice the original string rather than re-serializing the URL, so the
  // message shows exactly what was passed in (URL.toString() would append a
  // trailing "/" to an authority-only http URL).
  const marker = `:${url.password}@`;
  const idx = proxyUrl.indexOf(marker);
  if (idx !== -1) {
    return `${proxyUrl.slice(0, idx)}:***@${proxyUrl.slice(idx + marker.length)}`;
  }
  url.password = "***";
  return url.toString();
}

/**
 * Prefix a variable name must carry to be readable via ${...} expansion.
 *
 * Expansion lets a caller keep a credential out of the tool call, but it also
 * lets the caller read the server's environment. Namespacing keeps that
 * deliberate: an agent cannot reach ${AWS_SECRET_ACCESS_KEY} and forward it to
 * a host of its choosing as Proxy-Authorization.
 */
const ENV_PREFIX = "PROXY_MCP_";

/**
 * Expand ${PROXY_MCP_*} placeholders in an upstream proxy URL from the
 * environment, so credentials need not appear in the tool call.
 *
 * Throws on an unprefixed name, or on a variable that is unset or empty. An
 * empty expansion is never silently allowed: it would produce a broken upstream
 * that is very hard to diagnose. Bare $VAR is left alone, so existing literal
 * URLs containing "$" keep working.
 */
export function expandProxyUrlEnv(
  proxyUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return proxyUrl.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (!name.startsWith(ENV_PREFIX)) {
      throw new Error(
        `Refusing to expand \${${name}}: only variables prefixed with ${ENV_PREFIX} can be read.`,
      );
    }
    const value = env[name];
    if (!value) {
      throw new Error(`Environment variable ${name} is unset or empty.`);
    }
    return value;
  });
}
