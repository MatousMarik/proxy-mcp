/**
 * Unit tests for the Camoufox interceptor's pure helpers.
 *
 * The full activate() path spawns a Python subprocess, so it's covered by
 * the integration suite (skipped when camoufox isn't installed). Here we
 * exercise the pieces that work in pure Node: launcher script generation
 * and the Websocket-endpoint stream parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { buildLauncherScript, awaitWsEndpoint, CamoufoxInterceptor } from "../../src/interceptors/camoufox.js";

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

describe("buildLauncherScript", () => {
  it("embeds JSON params and references launch_server", () => {
    const script = buildLauncherScript({ headless: true, proxy: { server: "http://127.0.0.1:9000" } });
    assert.match(script, /from camoufox\.server import launch_server/);
    assert.match(script, /params = json\.loads\('/);
    assert.match(script, /launch_server\(\*\*params\)/);
    assert.match(script, /signal\.signal\(signal\.SIGTERM/);
  });

  it("escapes single quotes in nested params", () => {
    const script = buildLauncherScript({ note: "it's fine" });
    // JSON.stringify produces "it's fine" -> in our escape pass, `'` -> `\'`
    assert.match(script, /it\\'s fine/);
  });

  it("preserves JSON shape (round-trips through Python literal escape)", () => {
    const params = { os: ["windows", "macos"], block_webrtc: true, proxy: { server: "http://x" } };
    const script = buildLauncherScript(params);
    const m = /params = json\.loads\('([\s\S]*?)'\)/.exec(script);
    assert.ok(m, "expected to find JSON literal in script");
    // Reverse the Python escape (\\ and \') to recover the original JSON.
    const recovered = m![1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    assert.deepEqual(JSON.parse(recovered), params);
  });
});

describe("awaitWsEndpoint", () => {
  it("resolves with the wsUrl when the line is on stderr", async () => {
    const { proc, stderr } = fakeProc();
    const p = awaitWsEndpoint(proc, 5_000);
    setImmediate(() => stderr.push("starting up...\nWebsocket endpoint: ws://127.0.0.1:55555/abc\n"));
    const wsUrl = await p;
    assert.equal(wsUrl, "ws://127.0.0.1:55555/abc");
  });

  it("resolves when the line is on stdout", async () => {
    const { proc, stdout } = fakeProc();
    const p = awaitWsEndpoint(proc, 5_000);
    setImmediate(() => stdout.push("Websocket endpoint: ws://127.0.0.1:1/x"));
    const wsUrl = await p;
    assert.equal(wsUrl, "ws://127.0.0.1:1/x");
  });

  it("rejects when the process exits before emitting the endpoint", async () => {
    const { proc, stderr, emitExit } = fakeProc();
    const p = awaitWsEndpoint(proc, 5_000);
    setImmediate(() => {
      stderr.push("ImportError: No module named camoufox\n");
      emitExit(1);
    });
    await assert.rejects(p, /exited.*before emitting Websocket endpoint/);
  });

  it("rejects on timeout", async () => {
    const { proc } = fakeProc();
    const p = awaitWsEndpoint(proc, 50);
    await assert.rejects(p, /Timed out.*Websocket endpoint/);
  });

  it("handles the line being split across multiple chunks", async () => {
    const { proc, stderr } = fakeProc();
    const p = awaitWsEndpoint(proc, 5_000);
    setImmediate(() => {
      stderr.push("Websocket endpo");
      setImmediate(() => stderr.push("int: ws://1.2.3.4:9/path\n"));
    });
    const wsUrl = await p;
    assert.equal(wsUrl, "ws://1.2.3.4:9/path");
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
