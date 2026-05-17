/**
 * Camoufox tools — launch, info, list, close for the camoufox interceptor.
 *
 * Camoufox runs as a Playwright WS server; the four tools here give MCP
 * clients enough to start one, get the wsUrl, list active instances, and
 * close them. Page-level navigation/screenshot/etc. is the caller's job —
 * they connect via `firefox.connect(wsUrl)` and drive Playwright themselves.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { proxyManager } from "../state.js";
import { interceptorManager } from "../interceptors/manager.js";
import type { CamoufoxInterceptor } from "../interceptors/camoufox.js";

function errorToString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (obj.message) return String(obj.message);
    if (obj.name) return String(obj.name);
    try { return JSON.stringify(e); } catch { /* circular */ }
  }
  return String(e);
}

function requireProxy(): { proxyPort: number; certPem: string; certFingerprint: string } {
  if (!proxyManager.isRunning()) {
    throw new Error("Proxy is not running. Start it first with proxy_start.");
  }
  const cert = proxyManager.getCert();
  if (!cert) {
    throw new Error("No certificate available. Start the proxy first.");
  }
  return {
    proxyPort: proxyManager.getPort()!,
    certPem: cert.cert,
    certFingerprint: cert.fingerprint,
  };
}

const osEnum = z.enum(["windows", "macos", "linux"]);

export function registerCamoufoxTools(server: McpServer): void {
  server.tool(
    "interceptor_camoufox_launch",
    "Launch camoufox (anti-detect Firefox) as a Playwright WebSocket server, proxied through proxy-mcp with NSS CA trust. Returns a camoufox target_id plus wsUrl; drive the target with interceptor_browser_* and humanizer_* tools, or use wsUrl for custom Playwright code. Requires `pip install cloverlabs-camoufox[geoip]` + `python3 -m camoufox fetch official/150.0.2-alpha.26` on the host (and `libnss3-tools` for cert trust).",
    {
      os: z.union([osEnum, z.array(osEnum)]).optional().describe("Fingerprint OS to emulate (defaults to camoufox random)"),
      webgl_config: z.tuple([z.string(), z.string()]).optional().describe("[vendor, renderer] WebGL pair (must be valid for the chosen OS)"),
      fonts: z.array(z.string()).optional().describe("Extra font families to inject (must be installed on the host)"),
      config: z.record(z.unknown()).optional().describe("Raw camoufox config property overrides (advanced)"),
      humanize: z.union([z.boolean(), z.number().positive()]).optional().describe("true = humanize cursor; number = max seconds for cursor humanization"),
      headless: z.union([z.boolean(), z.literal("virtual")]).optional().default(true).describe("true (default), false, or 'virtual' (Xvfb on Linux)"),
      addons: z.array(z.string()).optional().describe("Paths to extracted Firefox addon directories"),
      main_world_eval: z.boolean().optional().describe("Allow `mw:`-prefixed evaluate() calls in the main world"),
      enable_cache: z.boolean().optional().describe("Cache pages/requests (disabled by default)"),
      disable_coop: z.boolean().optional().describe("Disable COOP — needed for Cloudflare Turnstile iframes"),
      block_webrtc: z.boolean().optional().default(true).describe("Block WebRTC to prevent IP leaks (default true)"),
      block_webgl: z.boolean().optional().describe("Block WebGL entirely"),
      block_images: z.boolean().optional().describe("Block image requests (saves proxy bandwidth)"),
      locale: z.union([z.string(), z.array(z.string())]).optional().describe("BCP 47 locale or 2-letter country code"),
      geoip: z.union([z.boolean(), z.string()]).optional().default(true).describe("true (auto-detect from proxy IP), false, or explicit IP string"),
      port: z.number().optional().describe("Fixed WS server port (default: random)"),
      ws_path: z.string().optional().describe("Fixed WS URL path (default: random)"),
      python_executable: z.string().optional().default("python3").describe("Python executable for the launcher (e.g. 'uv run python3')"),
      trust_proxy_cert: z.boolean().optional().default(true).describe("Run certutil to inject the proxy CA into a fresh NSS profile (default true)"),
    },
    async (args) => {
      try {
        const proxyInfo = requireProxy();
        const result = await interceptorManager.activate("camoufox", { ...proxyInfo, ...args });
        const details = result.details as Record<string, unknown>;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "success",
              targetId: result.targetId,
              wsUrl: details.wsUrl,
              playwright_connect: details.playwright_connect,
              fingerprint: {
                os: details.os ?? null,
                humanize: details.humanize ?? null,
                geoip: details.geoip ?? null,
                locale: details.locale ?? null,
                headless: details.headless ?? null,
                block_webrtc: details.block_webrtc ?? null,
              },
              certutil: details.certutil ?? false,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: errorToString(e) }) }] };
      }
    },
  );

  server.tool(
    "interceptor_camoufox_info",
    "Get the wsUrl and ready-to-paste Playwright connect snippets (TS + Python) for a camoufox target.",
    {
      target_id: z.string().describe("Target ID from interceptor_camoufox_launch"),
    },
    async ({ target_id }) => {
      try {
        const fox = interceptorManager.get("camoufox") as CamoufoxInterceptor | undefined;
        if (!fox) throw new Error("Camoufox interceptor not registered.");
        const entry = fox.getEntry(target_id);
        if (!entry) throw new Error(`No camoufox instance with target ID '${target_id}'`);
        const wsUrl = entry.wsUrl;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "success",
              targetId: target_id,
              wsUrl,
              snippets: {
                typescript: [
                  "import { firefox } from 'playwright-core';",
                  `const browser = await firefox.connect('${wsUrl}');`,
                  "const ctx = await browser.newContext();",
                  "const page = await ctx.newPage();",
                  "await page.goto('https://example.com');",
                ].join("\n"),
                python: [
                  "from playwright.sync_api import sync_playwright",
                  "with sync_playwright() as p:",
                  `    browser = p.firefox.connect('${wsUrl}')`,
                  "    page = browser.new_page()",
                  "    page.goto('https://example.com')",
                ].join("\n"),
              },
              details: entry.target.details,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: errorToString(e) }) }] };
      }
    },
  );

  server.tool(
    "interceptor_camoufox_list",
    "List all active camoufox instances with their wsUrl and fingerprint details.",
    {},
    async () => {
      try {
        const fox = interceptorManager.get("camoufox") as CamoufoxInterceptor | undefined;
        if (!fox) throw new Error("Camoufox interceptor not registered.");
        const meta = await fox.getMetadata();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "success",
              isActivable: meta.isActivable,
              targets: meta.activeTargets,
            }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: errorToString(e) }) }] };
      }
    },
  );

  server.tool(
    "interceptor_camoufox_close",
    "Close a camoufox instance launched by interceptor_camoufox_launch. Kills the Python launcher, removes the temp launcher dir, and removes the NSS profile dir if one was created.",
    {
      target_id: z.string().describe("Target ID from interceptor_camoufox_launch"),
    },
    async ({ target_id }) => {
      try {
        await interceptorManager.deactivate("camoufox", target_id);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "success", message: `Camoufox instance ${target_id} closed.` }),
          }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ status: "error", error: errorToString(e) }) }] };
      }
    },
  );
}
