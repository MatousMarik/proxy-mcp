import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { truncateResult, getLocalIP, serializeHeaders, capString, redactProxyUrl } from "../../src/utils.js";

describe("truncateResult", () => {
  it("returns short data unchanged", () => {
    const data = { foo: "bar" };
    const result = truncateResult(data);
    assert.equal(result, JSON.stringify(data));
  });

  it("truncates large arrays with binary search", () => {
    const data = Array.from({ length: 5000 }, (_, i) => ({ id: i, value: "x".repeat(100) }));
    const result = truncateResult(data);
    const parsed = JSON.parse(result);
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.showing < 5000);
    assert.equal(parsed.total, 5000);
    assert.ok(result.length <= 24000);
  });

  it("truncates large strings", () => {
    const data = "x".repeat(30000);
    const result = truncateResult(data);
    assert.ok(result.length <= 24000);
    assert.ok(result.includes("[truncated"));
  });
});

describe("getLocalIP", () => {
  it("returns a valid IP string", () => {
    const ip = getLocalIP();
    assert.ok(typeof ip === "string");
    assert.ok(ip.length > 0);
  });
});

describe("serializeHeaders", () => {
  it("lowercases keys and joins arrays", () => {
    const headers = {
      "Content-Type": "application/json",
      "X-Custom": ["a", "b"],
      "X-Undefined": undefined,
    };
    const result = serializeHeaders(headers);
    assert.equal(result["content-type"], "application/json");
    assert.equal(result["x-custom"], "a, b");
    assert.ok(!("x-undefined" in result));
  });
});

describe("capString", () => {
  it("returns short strings unchanged", () => {
    assert.equal(capString("hello", 10), "hello");
  });

  it("truncates long strings with ellipsis", () => {
    assert.equal(capString("hello world", 5), "hello...");
  });
});

describe("redactProxyUrl", () => {
  it("redacts the password and keeps the username", () => {
    assert.equal(
      redactProxyUrl("http://user:s3cret@proxy.example.com:8000"),
      "http://user:***@proxy.example.com:8000",
    );
  });

  it("keeps a username that encodes configuration", () => {
    assert.equal(
      redactProxyUrl("http://groups-RESIDENTIAL,country-US:apify_proxy_abc@proxy.apify.com:8000"),
      "http://groups-RESIDENTIAL,country-US:***@proxy.apify.com:8000",
    );
  });

  it("leaves a URL without a password unchanged", () => {
    assert.equal(redactProxyUrl("http://proxy.example.com:8000"), "http://proxy.example.com:8000");
    assert.equal(redactProxyUrl("http://user@proxy.example.com:8000"), "http://user@proxy.example.com:8000");
    assert.equal(redactProxyUrl("http://user:@proxy.example.com:8000"), "http://user:@proxy.example.com:8000");
  });

  it("does not append a trailing slash", () => {
    assert.ok(!redactProxyUrl("http://user:pass@host:8000").endsWith("/"));
  });

  it("handles socks and pac schemes", () => {
    assert.equal(redactProxyUrl("socks5://user:pass@host:1080"), "socks5://user:***@host:1080");
    assert.equal(redactProxyUrl("socks4://host:1080"), "socks4://host:1080");
    assert.equal(
      redactProxyUrl("pac+http://example.com/proxy.pac"),
      "pac+http://example.com/proxy.pac",
    );
  });

  it("redacts percent-encoded credentials", () => {
    assert.equal(
      redactProxyUrl("http://us%40er:p%3Aass@host:8000"),
      "http://us%40er:***@host:8000",
    );
  });

  it("never echoes an unparseable value", () => {
    assert.equal(redactProxyUrl("not a url"), "<unparseable url>");
    assert.equal(redactProxyUrl(""), "<unparseable url>");
  });

  it("leaves no trace of the secret in its output", () => {
    const out = redactProxyUrl("http://user:topsecret@host:8000");
    assert.ok(!out.includes("topsecret"));
  });
});
