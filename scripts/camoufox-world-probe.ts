// Probe camoufox JS-execution world placement.
//
// PoC 1: page.addInitScript writes a marker. A page inline <script> reads it
//        into document.title. If we see the marker → init reaches main world.
// PoC 2: page.addInitScript patches Function.prototype.toString. A page inline
//        <script> calls it and stores into document.title. If the patch shows
//        in title → init script's patch reached main world.
//
// Run:  npx tsx scripts/camoufox-world-probe.ts --venv=/tmp/camoufox-venv
//       npx tsx scripts/camoufox-world-probe.ts --venv=/tmp/camoufox-daijro-venv

import { firefox } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const venv = (process.argv.find((a) => a.startsWith("--venv=")) ?? "--venv=/tmp/camoufox-venv").slice(7);
const pythonExe = join(venv, "bin", "python3");
const label = venv.endsWith("daijro-venv") ? "daijro" : "cloverlabs";

const launcherPy = (wsFile: string, mainWorldEval: boolean): string => [
  "import sys, json, base64, subprocess, re",
  "from pathlib import Path",
  "import orjson",
  "from camoufox.server import LAUNCH_SCRIPT, get_nodejs, to_camel_case_dict",
  "from camoufox.utils import launch_options",
  `_WS_FILE = ${JSON.stringify(wsFile)}`,
  "_ANSI = re.compile(r'\\x1b\\[[0-9;]*m')",
  "_WS_RE = re.compile(r'Websocket endpoint:\\s*(ws://\\S+)')",
  `config = launch_options(headless=True, main_world_eval=${mainWorldEval ? "True" : "False"}, geoip=False, humanize=False)`,
  // daijro 0.4.11 rejects proxy=null; strip it when absent.
  "if config.get('proxy') is None: config.pop('proxy', None)",
  "nodejs = get_nodejs()",
  "data = orjson.dumps(to_camel_case_dict(config))",
  "proc = subprocess.Popen([nodejs, str(LAUNCH_SCRIPT)],",
  "    cwd=str(Path(nodejs).parent / 'package'),",
  "    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,",
  "    text=True, bufsize=1)",
  "if proc.stdin: proc.stdin.write(base64.b64encode(data).decode()); proc.stdin.close()",
  "for line in proc.stdout:",
  "    sys.stdout.write(line); sys.stdout.flush()",
  "    m = _WS_RE.search(_ANSI.sub('', line))",
  "    if m:",
  "        with open(_WS_FILE, 'w') as f: f.write(json.dumps({'wsUrl': m.group(1)}))",
  "proc.wait()",
].join("\n");

async function launchOnce(mainWorldEval: boolean) {
  const dir = await mkdtemp(join(tmpdir(), `cam-probe-${label}-`));
  const wsFile = join(dir, "ws.json");
  const scriptPath = join(dir, "launch.py");
  await writeFile(scriptPath, launcherPy(wsFile, mainWorldEval), "utf-8");

  const proc = spawn(pythonExe, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (b) => process.stderr.write(`[py.${label}] ${b}`));

  let ws = "";
  for (let i = 0; i < 120; i++) {
    try { ws = JSON.parse(await readFile(wsFile, "utf-8")).wsUrl; break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!ws) { proc.kill("SIGTERM"); await rm(dir, { recursive: true, force: true }); throw new Error(`[${label}] no ws endpoint`); }
  return { ws, dir, proc };
}

async function poc1_initMarker(): Promise<{ pass: boolean; raw: unknown }> {
  // Init script sets a marker. Page <script> reads it into document.title.
  const { ws, dir, proc } = await launchOnce(false);
  try {
    const browser = await firefox.connect(ws);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.addInitScript({ content: "window.__init_marker = 'set-by-init';" });
    const html = `<html><head><title>pending</title><script>document.title = String(window.__init_marker);<\/script></head><body>x</body></html>`;
    await page.goto("data:text/html," + encodeURIComponent(html));
    const title = await page.title();
    await browser.close();
    return { pass: title === "set-by-init", raw: title };
  } finally {
    proc.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
}

async function poc2_toStringPatch(): Promise<{ pass: boolean; raw: unknown }> {
  // Init script patches Function.prototype.toString. Page <script> calls it.
  const { ws, dir, proc } = await launchOnce(false);
  try {
    const browser = await firefox.connect(ws);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.addInitScript({
      content:
        "const __orig = Function.prototype.toString;" +
        "Function.prototype.toString = function(){ return 'PATCHED:' + __orig.call(this); };",
    });
    const html = `<html><head><title>pending</title><script>document.title = Function.prototype.toString.toString();<\/script></head><body>x</body></html>`;
    await page.goto("data:text/html," + encodeURIComponent(html));
    const title = await page.title();
    await browser.close();
    return { pass: title.startsWith("PATCHED:"), raw: title };
  } finally {
    proc.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
}

async function poc3_evalIsolation(): Promise<{ pass: boolean; raw: unknown }> {
  // Verify the previously-observed "evaluate sees page globals" claim on
  // whatever build this is, fresh launch.
  const { ws, dir, proc } = await launchOnce(true);
  try {
    const browser = await firefox.connect(ws);
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const html = `<html><head><script>window.__page_set='from-page';<\/script></head><body>x</body></html>`;
    await page.goto("data:text/html," + encodeURIComponent(html));
    const fromDefault = await page.evaluate("(() => window.__page_set)()");
    const fromMw = await page.evaluate("mw:(() => window.__page_set)()");
    await browser.close();
    // pass = isolation holds (default cannot see page global)
    return { pass: fromDefault === undefined, raw: { fromDefault, fromMw } };
  } finally {
    proc.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log(`==== camoufox world probe: ${label} (venv=${venv}) ====`);

  console.log("\n[PoC 1] page.addInitScript marker visible to page <script>?");
  const r1 = await poc1_initMarker();
  console.log(`  result: title=${JSON.stringify(r1.raw)}  →  init reaches main world: ${r1.pass ? "YES" : "NO"}`);

  console.log("\n[PoC 2] addInitScript patch of Function.prototype.toString visible to page <script>?");
  const r2 = await poc2_toStringPatch();
  console.log(`  result: title=${JSON.stringify(r2.raw)}  →  stealth patch reaches page: ${r2.pass ? "YES" : "NO"}`);

  console.log("\n[PoC 3] default page.evaluate isolated from page main world?");
  const r3 = await poc3_evalIsolation();
  console.log(`  result: ${JSON.stringify(r3.raw)}  →  isolation holds: ${r3.pass ? "YES" : "NO"}`);

  console.log("\nSUMMARY:");
  console.log(`  ${label}  init→main=${r1.pass ? "Y" : "N"}  stealth_patch=${r2.pass ? "Y" : "N"}  eval_isolated=${r3.pass ? "Y" : "N"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
