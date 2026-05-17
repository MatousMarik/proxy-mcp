/**
 * Unit tests for the Camoufox interceptor's pure helpers.
 *
 * The full activate() path spawns a Python subprocess, so it's covered by
 * the integration suite (skipped when camoufox isn't installed). Here we
 * exercise the pieces that work in pure Node: launcher script generation
 * and the file-based Websocket-endpoint handshake.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import {
  buildLauncherScript,
  awaitWsEndpoint,
  awaitWsHandshake,
  hostFingerprintOs,
  CamoufoxInterceptor,
} from "../../src/interceptors/camoufox.js";

function fakeProc(): { proc: ChildProcess; stdout: Readable; stderr: Readable; emitExit: (code: number | null) => void } {
  const stdout = new Readable({ read() { /* push manually */ } });
  const stderr = new Readable({ read() { /* push manually */ } });
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  (emitter as unknown as { stdout: Readable }).stdout = stdout;
  (emitter as unknown as { stderr: Readable }).stderr = stderr;
  (emitter as unknown as { kill: () => boolean }).kill = () => true;
  return {
    proc: emitter as unknown as ChildProcess,
    stdout,
    stderr,
    emitExit: (code) => emitter.emit("exit", code, null),
  };
}

async function tmpHandshakeFile(): Promise<{ dir: string; file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "proxy-mcp-test-"));
  const file = join(dir, "ws-endpoint.json");
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function atomicWriteHandshake(
  file: string,
  wsUrl: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const dir = file.substring(0, file.lastIndexOf("/"));
  const tmp = join(dir, `.ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify({ wsUrl, ts: Math.floor(Date.now() / 1000), ...extra }), "utf-8");
  await rename(tmp, file);
}

describe("hostFingerprintOs", () => {
  it("maps Node platforms to Camoufox OS families", () => {
    assert.equal(hostFingerprintOs("linux"), "linux");
    assert.equal(hostFingerprintOs("darwin"), "macos");
    assert.equal(hostFingerprintOs("win32"), "windows");
    assert.equal(hostFingerprintOs("freebsd"), undefined);
  });
});

describe("buildLauncherScript", () => {
  it("emits a script that imports the camoufox primitives we wrap", () => {
    const script = buildLauncherScript(
      { headless: true, proxy: { server: "http://127.0.0.1:9000" } },
      "/tmp/proxy-mcp-camoufox-XXX/ws-endpoint.json",
    );
    assert.match(script, /from camoufox\.server import LAUNCH_SCRIPT, get_nodejs, to_camel_case_dict/);
    assert.match(script, /from camoufox\.utils import launch_options/);
    assert.match(script, /params = json\.loads\('/);
    assert.match(script, /signal\.signal\(signal\.SIGTERM/);
  });

  it("embeds the websocket-endpoint file path", () => {
    const script = buildLauncherScript({}, "/tmp/proxy-mcp-camoufox-ABC/ws-endpoint.json");
    assert.match(script, /_WS_FILE = '\/tmp\/proxy-mcp-camoufox-ABC\/ws-endpoint\.json'/);
  });

  it("strips ANSI escapes from the WS-line scan inside the python wrapper", () => {
    const script = buildLauncherScript({}, "/tmp/x");
    // The wrapper pre-processes captured lines through this stdlib regex
    // before parsing the wsUrl, so colour codes never leak into the
    // handshake file.
    assert.match(script, /_ANSI = re\.compile/);
    assert.match(script, /_ANSI\.sub\(''\s*,\s*line\)/);
  });

  it("escapes single quotes in nested params", () => {
    const script = buildLauncherScript({ note: "it's fine" }, "/tmp/x");
    // JSON.stringify produces "it's fine" -> in our escape pass, `'` -> `\'`
    assert.match(script, /it\\'s fine/);
  });

  it("preserves JSON shape (round-trips through Python literal escape)", () => {
    const params = { os: ["windows", "macos"], block_webrtc: true, proxy: { server: "http://x" } };
    const script = buildLauncherScript(params, "/tmp/x");
    const m = /params = json\.loads\('([\s\S]*?)'\)/.exec(script);
    assert.ok(m, "expected to find JSON literal in script");
    // Reverse the Python escape (\\ and \') to recover the original JSON.
    const recovered = m![1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    assert.deepEqual(JSON.parse(recovered), params);
  });

  it("emits safe fingerprint introspection without exposing raw launch config", () => {
    const script = buildLauncherScript({ os: "linux" }, "/tmp/x");
    assert.match(script, /CAMOU_CONFIG_1/);
    assert.match(script, /fingerprint_summary = _fingerprint_summary\(config\)/);
    assert.match(script, /'user_agent': _pick\(cam, 'navigator\.userAgent'\)/);
    assert.doesNotMatch(script, /json\.dumps\(\{'wsUrl': m\.group\(1\), 'ts': int\(time\.time\(\)\), 'config': config/);
  });
});

describe("awaitWsEndpoint (file-based handshake)", () => {
  it("resolves when the python wrapper writes the handshake file", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc } = fakeProc();
      const p = awaitWsEndpoint(proc, file, 5_000);
      setImmediate(() => atomicWriteHandshake(file, "ws://127.0.0.1:55555/abc"));
      const wsUrl = await p;
      assert.equal(wsUrl, "ws://127.0.0.1:55555/abc");
    } finally {
      await cleanup();
    }
  });

  it("returns fingerprint details from the structured handshake", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc } = fakeProc();
      const p = awaitWsHandshake(proc, file, 5_000);
      setImmediate(() => atomicWriteHandshake(file, "ws://127.0.0.1:55555/abc", {
        fingerprint: {
          os: "linux",
          user_agent: "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
        },
      }));
      const handshake = await p;
      assert.equal(handshake.wsUrl, "ws://127.0.0.1:55555/abc");
      assert.equal(handshake.fingerprint?.os, "linux");
      assert.match(String(handshake.fingerprint?.user_agent), /Firefox\/150/);
    } finally {
      await cleanup();
    }
  });

  it("rejects when the process exits before the file appears", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc, stderr, emitExit } = fakeProc();
      const p = awaitWsEndpoint(proc, file, 5_000);
      setImmediate(() => {
        stderr.push("ImportError: No module named camoufox\n");
        emitExit(1);
      });
      await assert.rejects(p, /exited.*before emitting Websocket endpoint/);
    } finally {
      await cleanup();
    }
  });

  it("captures stderr tail in the failure message", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc, stderr, emitExit } = fakeProc();
      const p = awaitWsEndpoint(proc, file, 5_000);
      setImmediate(() => {
        stderr.push("FATAL: my unique diagnostic string-12345");
        emitExit(2);
      });
      await assert.rejects(p, /unique diagnostic string-12345/);
    } finally {
      await cleanup();
    }
  });

  it("rejects on timeout", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc } = fakeProc();
      const p = awaitWsEndpoint(proc, file, 50);
      await assert.rejects(p, /Timed out.*Websocket endpoint/);
    } finally {
      await cleanup();
    }
  });

  it("ignores ANSI / log noise in the proc stderr — only the file matters", async () => {
    const { file, cleanup } = await tmpHandshakeFile();
    try {
      const { proc, stderr } = fakeProc();
      const p = awaitWsEndpoint(proc, file, 5_000);
      setImmediate(() => {
        // Whatever camoufox prints (with or without colour) is irrelevant —
        // the handshake only triggers when the file lands.
        stderr.push("\x1b[93mWebsocket endpoint:\x1b[0m \x1b[36mws://decoy:0/garbage\x1b[0m\n");
      });
      // No file write yet → nothing to resolve. After we write the real one, it should resolve.
      setTimeout(() => atomicWriteHandshake(file, "ws://real:1234/path"), 100);
      const wsUrl = await p;
      assert.equal(wsUrl, "ws://real:1234/path");
    } finally {
      await cleanup();
    }
  });
});

describe("CamoufoxInterceptor.isActivable", () => {
  it("returns false when python3 cannot import camoufox (cached)", async () => {
    // We can't reliably mock spawnSync here without a DI surface; instead
    // poke the private cache to assert the cached path returns the cached
    // value without re-probing. This guards against regressions in caching.
    const fox = new CamoufoxInterceptor();
    (fox as unknown as { _activable: boolean | null })._activable = false;
    assert.equal(await fox.isActivable(), false);
    (fox as unknown as { _activable: boolean | null })._activable = true;
    assert.equal(await fox.isActivable(), true);
  });
});

describe("CamoufoxInterceptor metadata shape", () => {
  it("reports id, name, and empty active list when nothing launched", async () => {
    const fox = new CamoufoxInterceptor();
    (fox as unknown as { _activable: boolean | null })._activable = false;
    const meta = await fox.getMetadata();
    assert.equal(meta.id, "camoufox");
    assert.equal(meta.activeTargets.length, 0);
    assert.equal(typeof meta.description, "string");
    assert.ok(meta.description.length > 0);
  });
});
