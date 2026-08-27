import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "node:url";
import { truncateResult, getLocalIP, serializeHeaders, capString, redactProxyUrl, mergeUpstreamPassword } from "../../src/utils.js";

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
      "http://user:***@proxy.example.com:8000/",
    );
  });

  it("keeps a username that encodes configuration", () => {
    assert.equal(
      redactProxyUrl("http://groups-RESIDENTIAL,country-US:apify_proxy_abc@proxy.apify.com:8000"),
      "http://groups-RESIDENTIAL,country-US:***@proxy.apify.com:8000/",
    );
  });

  it("leaves a URL without a password alone", () => {
    assert.equal(redactProxyUrl("http://proxy.example.com:8000"), "http://proxy.example.com:8000/");
    assert.equal(redactProxyUrl("http://user@proxy.example.com:8000"), "http://user@proxy.example.com:8000/");
  });

  it("redacts a pac+http token carried in the query", () => {
    const out = redactProxyUrl("pac+http://pac.example.com/proxy.pac?token=SECRET");
    assert.ok(!out.includes("SECRET"));
    assert.equal(out, "pac+http://pac.example.com/proxy.pac?token=***");
  });

  it("redacts a password duplicated into the query", () => {
    assert.ok(!redactProxyUrl("http://u:SECRET@host:8000?dup=SECRET").includes("SECRET"));
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
      "http://us%40er:***@host:8000/",
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

describe("mergeUpstreamPassword", () => {
  const env = { PROXY_MCP_UPSTREAM_PASSWORD: "s3cret" };

  it("fills the password slot of a username-only URL", () => {
    assert.equal(
      mergeUpstreamPassword("http://groups-RESIDENTIAL,country-US@proxy.apify.com:8000", env),
      "http://groups-RESIDENTIAL,country-US:s3cret@proxy.apify.com:8000/",
    );
  });

  it("puts the secret nowhere but the password slot", () => {
    const out = mergeUpstreamPassword("http://user@host:8000/path?q=1", env);
    const url = new URL(out);
    assert.equal(url.password, "s3cret");
    assert.equal(url.username, "user");
    assert.equal(url.host, "host:8000");
    assert.equal(url.pathname, "/path");
    assert.equal(url.search, "?q=1");
  });

  it("percent-encodes a password that would otherwise re-point the upstream", () => {
    const out = mergeUpstreamPassword("http://user@host:8000", {
      PROXY_MCP_UPSTREAM_PASSWORD: "p@evil.example:80/",
    });
    assert.equal(new URL(out).host, "host:8000");
    assert.ok(!out.includes("@evil.example"));
  });

  it("survives mockttp's url.parse().auth round-trip", () => {
    // mockttp reads credentials via legacy url.parse().auth (rules/http-agents.js),
    // which percent-decodes. Encoding here must therefore be lossless, or a
    // password containing "@" or "/" would authenticate with the wrong value.
    const secret = "p@ss/word:with#specials";
    const out = mergeUpstreamPassword("http://user@host:8000", {
      PROXY_MCP_UPSTREAM_PASSWORD: secret,
    });
    assert.equal(parse(out).auth, `user:${secret}`);
    assert.equal(new URL(out).host, "host:8000");
  });

  it("leaves an explicit password alone", () => {
    assert.equal(
      mergeUpstreamPassword("http://user:mine@host:8000", env),
      "http://user:mine@host:8000",
    );
  });

  it("leaves a URL with no username alone", () => {
    assert.equal(mergeUpstreamPassword("http://host:8000", env), "http://host:8000");
  });

  it("is a no-op when the variable is unset", () => {
    assert.equal(mergeUpstreamPassword("http://user@host:8000", {}), "http://user@host:8000");
  });

  it("returns an unparseable URL untouched for the caller to reject", () => {
    assert.equal(mergeUpstreamPassword("not a url", env), "not a url");
  });
});
