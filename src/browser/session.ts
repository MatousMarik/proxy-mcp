/**
 * Shared helpers for resolving a Playwright Page from a browser interceptor target ID.
 * Used by humanizer and browser tools so they don't each re-walk the interceptor map.
 *
 * Resolves both cloakbrowser ("browser_*") and camoufox ("camoufox_*") targets.
 * Camoufox entries don't carry a Page eagerly — the interceptor returns a WS
 * endpoint and stops there. We connect lazily on first use via
 * `firefox.connect(wsUrl)` and cache the Browser/Context/Page on the entry, so
 * every `interceptor_browser_*` and `humanizer_*` tool call works identically
 * across both engines.
 */

import { firefox, type Browser, type BrowserContext, type ConsoleMessage, type Page } from "playwright-core";
import { interceptorManager } from "../interceptors/manager.js";
import type { BrowserInterceptor, BrowserTargetEntry, ConsoleEntry } from "../interceptors/browser.js";
import type { CamoufoxInterceptor, CamoufoxTargetEntry } from "../interceptors/camoufox.js";

interface CamoufoxDriverHandle {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  consoleBuffer?: ConsoleEntry[];
  consolePage?: Page;
}
type CamoufoxEntryWithDriver = CamoufoxTargetEntry & CamoufoxDriverHandle;

const CONSOLE_BUFFER_MAX = 500;

function getBrowserInterceptor(): BrowserInterceptor {
  const it = interceptorManager.get("browser") as BrowserInterceptor | undefined;
  if (!it) throw new Error("Browser interceptor not registered.");
  return it;
}

function getCamoufoxInterceptor(): CamoufoxInterceptor | undefined {
  return interceptorManager.get("camoufox") as CamoufoxInterceptor | undefined;
}

function isCamoufoxTargetId(targetId: string): boolean {
  return typeof targetId === "string" && targetId.startsWith("camoufox_");
}

export function isCamoufoxTarget(targetId: string): boolean {
  return isCamoufoxTargetId(targetId);
}

async function ensureCamoufoxPage(entry: CamoufoxEntryWithDriver): Promise<Page> {
  if (entry.page && !entry.page.isClosed()) return entry.page;
  if (!entry.browser) {
    entry.browser = await firefox.connect(entry.wsUrl);
  }
  let ctx = entry.browser.contexts()[0];
  if (!ctx) {
    // BrowserServer + persistent_context: the persistent context lives
    // server-side and `Browser.contexts()` from a fresh `firefox.connect()`
    // returns empty. New contexts created here do NOT inherit the
    // launch-level proxy, so we have to wire the MITM proxy explicitly
    // or the firefox process reaches the internet directly and bypasses
    // capture. Pull the port back out of the entry details (set at
    // activate() time).
    const proxyPort = (entry.target.details as { proxyPort?: number } | undefined)?.proxyPort;
    ctx = await entry.browser.newContext({
      ignoreHTTPSErrors: true,
      ...(proxyPort ? { proxy: { server: `http://127.0.0.1:${proxyPort}` } } : {}),
    });
  }
  let page = ctx.pages()[0];
  if (!page) {
    page = await ctx.newPage();
  }
  entry.context = ctx;
  entry.page = page;
  ensureConsoleBuffer(entry, page);
  return page;
}

function ensureConsoleBuffer(entry: CamoufoxEntryWithDriver, page: Page): ConsoleEntry[] {
  if (!entry.consoleBuffer) entry.consoleBuffer = [];
  if (entry.consolePage === page) return entry.consoleBuffer;

  entry.consolePage = page;
  page.on("console", (msg: ConsoleMessage) => {
    const loc = msg.location();
    entry.consoleBuffer?.push({
      type: msg.type(),
      text: msg.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}` : "",
      timestamp: Date.now(),
    });
    if (entry.consoleBuffer && entry.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
      entry.consoleBuffer.splice(0, entry.consoleBuffer.length - CONSOLE_BUFFER_MAX);
    }
  });

  return entry.consoleBuffer;
}

export function getEntry(targetId: string): BrowserTargetEntry | CamoufoxEntryWithDriver {
  if (isCamoufoxTargetId(targetId)) {
    const cam = getCamoufoxInterceptor();
    const entry = cam?.getEntry(targetId) as CamoufoxEntryWithDriver | undefined;
    if (!entry) throw new Error(`Browser target '${targetId}' not found. Is it still running?`);
    return entry;
  }
  const entry = getBrowserInterceptor().getEntry(targetId);
  if (!entry) throw new Error(`Browser target '${targetId}' not found. Is it still running?`);
  return entry;
}

/**
 * Cloakbrowser-only entry getter. Use when the caller needs cloakbrowser
 * internals rather than the shared page/context helpers. Camoufox targets get
 * a clear error instead of a deep type-mismatch.
 */
export function getBrowserEntry(targetId: string): BrowserTargetEntry {
  if (isCamoufoxTargetId(targetId)) {
    throw new Error(
      `Internal cloakbrowser-only entry requested for camoufox target ('${targetId}'). ` +
      "Use the shared browser tools for camoufox targets.",
    );
  }
  const entry = getBrowserInterceptor().getEntry(targetId);
  if (!entry) throw new Error(`Browser target '${targetId}' not found. Is it still running?`);
  return entry;
}

export async function getPageForTarget(targetId: string): Promise<Page> {
  const entry = getEntry(targetId);
  if (isCamoufoxTargetId(targetId)) {
    return ensureCamoufoxPage(entry as CamoufoxEntryWithDriver);
  }
  const browserEntry = entry as BrowserTargetEntry;
  if (browserEntry.page.isClosed()) {
    throw new Error(`Page for browser target '${targetId}' is closed.`);
  }
  return browserEntry.page;
}

export async function getContextForTarget(targetId: string): Promise<BrowserContext> {
  const entry = getEntry(targetId);
  if (isCamoufoxTargetId(targetId)) {
    const page = await ensureCamoufoxPage(entry as CamoufoxEntryWithDriver);
    return page.context();
  }
  return (entry as BrowserTargetEntry).context;
}

export async function getConsoleBufferForTarget(targetId: string): Promise<ConsoleEntry[]> {
  const entry = getEntry(targetId);
  if (isCamoufoxTargetId(targetId)) {
    const camoufoxEntry = entry as CamoufoxEntryWithDriver;
    const page = await ensureCamoufoxPage(camoufoxEntry);
    return ensureConsoleBuffer(camoufoxEntry, page);
  }
  return (entry as BrowserTargetEntry).consoleBuffer;
}
