/**
 * Camoufox interceptor — anti-detect Firefox via Playwright WS.
 *
 * Spawns a Python subprocess running `camoufox.server.launch_server()` with
 * the proxy pre-wired (so `geoip: true` resolves locale/tz from the proxy
 * exit IP). Exposes the Playwright WebSocket endpoint; caller drives pages
 * directly with `firefox.connect(wsUrl)`.
 *
 * CA trust: NSS profile dir created with `certutil -N` and the proxy CA
 * imported as `proxy-mcp-ca`. Camoufox is launched with `user_data_dir` and
 * `persistent_context: true` so the profile is actually used. If `certutil`
 * is not on PATH the launch still succeeds — the user gets a logged warning
 * and HTTPS pages will show cert errors (proxy traffic still flows).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Interceptor, InterceptorMetadata, ActivateOptions, ActivateResult, ActiveTarget,
} from "./types.js";

export interface CamoufoxTargetEntry {
  target: ActiveTarget;
  process: ChildProcess;
  wsUrl: string;
  profileDir: string | null;
  launcherDir: string;
}

const WS_REGEX = /Websocket endpoint:\s*(ws:\/\/\S+)/i;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const FORWARDED_PARAMS = [
  "os", "webgl_config", "fonts", "config", "humanize", "addons",
  "main_world_eval", "enable_cache", "disable_coop", "block_webgl",
  "block_images", "locale", "port", "ws_path",
] as const;

type CamoufoxParam = (typeof FORWARDED_PARAMS)[number];

export class CamoufoxInterceptor implements Interceptor {
  readonly id = "camoufox";
  readonly name = "Camoufox (anti-detect Firefox via Playwright)";

  private launched = new Map<string, CamoufoxTargetEntry>();
  private _activable: boolean | null = null;
  private _pythonExe: string = "python3";

  async isActivable(): Promise<boolean> {
    if (this._activable !== null) return this._activable;
    try {
      const r = spawnSync(this._pythonExe, ["-c", "import camoufox"], { stdio: "ignore" });
      this._activable = r.status === 0;
    } catch {
      this._activable = false;
    }
    return this._activable;
  }

  getEntry(targetId: string): CamoufoxTargetEntry | undefined {
    return this.launched.get(targetId);
  }

  listEntries(): CamoufoxTargetEntry[] {
    return [...this.launched.values()];
  }

  async activate(options: ActivateOptions): Promise<ActivateResult> {
    const { proxyPort, certPem } = options;
    const headless = options.headless === undefined ? true : Boolean(options.headless);
    const blockWebrtc = options.block_webrtc === undefined ? true : Boolean(options.block_webrtc);
    const geoip = options.geoip === undefined ? true : options.geoip as boolean | string;
    const trustProxyCert = options.trust_proxy_cert === undefined ? true : Boolean(options.trust_proxy_cert);
    const pythonExe = typeof options.python_executable === "string" && options.python_executable
      ? options.python_executable
      : "python3";

    const params: Record<string, unknown> = {
      proxy: { server: `http://127.0.0.1:${proxyPort}` },
      headless,
      block_webrtc: blockWebrtc,
      geoip,
    };

    for (const key of FORWARDED_PARAMS as readonly CamoufoxParam[]) {
      const v = (options as Record<string, unknown>)[key];
      if (v !== undefined) params[key] = v;
    }

    let profileDir: string | null = null;
    if (trustProxyCert) {
      profileDir = await this.injectCaIntoNssProfile(certPem);
      if (profileDir) {
        params.user_data_dir = profileDir;
        params.persistent_context = true;
      }
    }

    const launcherDir = await mkdtemp(join(tmpdir(), "proxy-mcp-camoufox-"));
    const scriptPath = join(launcherDir, "launch.py");
    await writeFile(scriptPath, buildLauncherScript(params), "utf-8");

    const proc = spawn(pythonExe, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });

    let wsUrl: string;
    try {
      wsUrl = await awaitWsEndpoint(proc, DEFAULT_LAUNCH_TIMEOUT_MS);
    } catch (e) {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      await rm(launcherDir, { recursive: true, force: true }).catch(() => {});
      if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }

    const pid = typeof proc.pid === "number" ? proc.pid : 0;
    const targetId = `camoufox_${pid}_${Date.now()}`;

    const details: Record<string, unknown> = {
      wsUrl,
      proxyPort,
      headless,
      humanize: options.humanize ?? null,
      geoip,
      block_webrtc: blockWebrtc,
      ...(options.os !== undefined ? { os: options.os } : {}),
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      profileDir,
      certutil: profileDir !== null,
      playwright_connect: `await firefox.connect('${wsUrl}')`,
    };

    const target: ActiveTarget = {
      id: targetId,
      description: `camoufox (headless=${headless})`,
      activatedAt: Date.now(),
      details,
    };

    const entry: CamoufoxTargetEntry = { target, process: proc, wsUrl, profileDir, launcherDir };
    this.launched.set(targetId, entry);

    proc.once("exit", () => {
      this.launched.delete(targetId);
      rm(launcherDir, { recursive: true, force: true }).catch(() => {});
      if (profileDir) rm(profileDir, { recursive: true, force: true }).catch(() => {});
    });

    return { targetId, details };
  }

  async deactivate(targetId: string): Promise<void> {
    const entry = this.launched.get(targetId);
    if (!entry) {
      throw new Error(`No camoufox instance with target ID '${targetId}'`);
    }

    const proc = entry.process;
    if (proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      const killed = await waitForExit(proc, 3_000);
      if (!killed) {
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        await waitForExit(proc, 1_000);
      }
    }

    await rm(entry.launcherDir, { recursive: true, force: true }).catch(() => {});
    if (entry.profileDir) {
      await rm(entry.profileDir, { recursive: true, force: true }).catch(() => {});
    }
    this.launched.delete(targetId);
  }

  async deactivateAll(): Promise<void> {
    const ids = [...this.launched.keys()];
    for (const id of ids) {
      try { await this.deactivate(id); } catch { /* best effort */ }
    }
  }

  async getMetadata(): Promise<InterceptorMetadata> {
    return {
      id: this.id,
      name: this.name,
      description:
        "Launch camoufox (anti-detect Firefox) as a Playwright WS server with proxy + NSS CA trust. " +
        "Caller drives pages via `firefox.connect(wsUrl)`. Requires Python + `pip install camoufox[geoip]`.",
      isActivable: await this.isActivable(),
      activeTargets: [...this.launched.values()].map((e) => e.target),
    };
  }

  /**
   * Create an NSS profile dir, run `certutil -N` (empty password) then
   * `certutil -A` to import the proxy CA. Returns the profile dir on
   * success, or null if certutil is missing / fails (degraded mode).
   */
  private async injectCaIntoNssProfile(certPem: string): Promise<string | null> {
    const probe = spawnSync("certutil", ["--help"], { stdio: "ignore" });
    if (probe.error || probe.status === undefined || probe.status === null) {
      console.error("[camoufox] certutil not found — launching without CA trust. HTTPS pages will show cert errors.");
      return null;
    }

    const profileDir = await mkdtemp(join(tmpdir(), "proxy-mcp-camoufox-nss-"));
    const initRes = spawnSync(
      "certutil",
      ["-N", "--empty-password", "-d", `sql:${profileDir}`],
      { stdio: "ignore" },
    );
    if (initRes.status !== 0) {
      console.error("[camoufox] certutil -N failed — launching without CA trust.");
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    const certPath = join(profileDir, "proxy-mcp-ca.pem");
    await writeFile(certPath, certPem, "utf-8");
    const addRes = spawnSync(
      "certutil",
      ["-A", "-n", "proxy-mcp-ca", "-t", "CT,,", "-d", `sql:${profileDir}`, "-i", certPath],
      { stdio: "ignore" },
    );
    if (addRes.status !== 0) {
      console.error("[camoufox] certutil -A failed — launching without CA trust.");
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }

    return profileDir;
  }
}

/* ----------------------------------------------------------------------- */
/*  Helpers (also exported for unit tests)                                  */
/* ----------------------------------------------------------------------- */

export function buildLauncherScript(params: Record<string, unknown>): string {
  const json = JSON.stringify(params);
  // Embed as a Python-safe string literal: backslash-escape backslashes and
  // single quotes, then drop the result inside single quotes. Newlines and
  // double quotes are already escaped by JSON.stringify.
  const escaped = json.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return [
    "import sys, json, signal",
    "from camoufox.server import launch_server",
    `params = json.loads('${escaped}')`,
    "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))",
    "launch_server(**params)",
    "",
  ].join("\n");
}

export function awaitWsEndpoint(proc: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";

    const onChunk = (chunk: Buffer | string) => {
      if (settled) return;
      buf += chunk.toString("utf-8");
      const m = WS_REGEX.exec(buf);
      if (m) {
        settled = true;
        cleanup();
        resolve(m[1]);
      }
    };

    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`camoufox launcher exited (code=${code}) before emitting Websocket endpoint. stderr: ${buf.slice(-500)}`));
    };

    const onTimeout = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for camoufox Websocket endpoint. last output: ${buf.slice(-500)}`));
    };

    const timer = setTimeout(onTimeout, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      proc.stdout?.off("data", onChunk);
      proc.stderr?.off("data", onChunk);
      proc.off("exit", onExit);
    }

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.once("exit", onExit);
  });
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
