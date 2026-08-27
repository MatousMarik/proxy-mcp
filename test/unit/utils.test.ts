import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "node:url";
import { truncateResult, getLocalIP, serializeHeaders, capString, redactProxyUrl, mergeUpstreamPassword, upstreamPasswordSource } from "../../src/utils.js";

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
    assert.equal(out, "pac+http://pac.example.com/***?token=***");
  });

  it("masks path segments and drops the fragment", () => {
    // A PAC provider may carry its token in the path rather than the query, and
    // no agent in this stack reads the fragment. Neither is worth echoing.
    assert.equal(
      redactProxyUrl("pac+http://pac.example.com/AbC123token/proxy.pac"),
      "pac+http://pac.example.com/***/***",
    );
    assert.ok(!redactProxyUrl("http://u:p@host:8000/tok#frag").includes("frag"));
    // An authority-only URL has no path to mask.
    assert.equal(redactProxyUrl("http://host:8000"), "http://host:8000/");
  });

  it("redacts a password duplicated into the query", () => {
    assert.ok(!redactProxyUrl("http://u:SECRET@host:8000?dup=SECRET").includes("SECRET"));
  });

  it("handles socks and pac schemes", () => {
    assert.equal(redactProxyUrl("socks5://user:pass@host:1080"), "socks5://user:***@host:1080");
    assert.equal(redactProxyUrl("socks4://host:1080"), "socks4://host:1080");
    assert.equal(
      redactProxyUrl("pac+http://example.com/proxy.pac"),
      "pac+http://example.com/***",
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
});

describe("mergeUpstreamPassword", () => {
  const env = { PROXY_MCP_UPSTREAM_PASSWORD: "s3cret", PROXY_MCP_UPSTREAM_HOST: "host" };
  const at = (hostname: string) => ({
    PROXY_MCP_UPSTREAM_PASSWORD: "s3cret",
    PROXY_MCP_UPSTREAM_HOST: hostname,
  });

  it("sends the password only to the pinned host", () => {
    // The password must not be deliverable to a host the caller picks: that is
    // exfiltration by delivery, which redaction cannot see.
    const out = mergeUpstreamPassword("http://x@attacker.example:8000", at("proxy.apify.com"));
    assert.equal(out, "http://x@attacker.example:8000");
    assert.equal(new URL(out).password, "");
  });

  it("matches the host case-insensitively and ignores the port", () => {
    assert.equal(
      new URL(mergeUpstreamPassword("http://u@Proxy.Example:9000", at("proxy.example"))).password,
      "s3cret",
    );
  });

  it("fails closed when the host variable is unset", () => {
    // A half-configuration must not degrade into an unbound credential.
    assert.equal(
      mergeUpstreamPassword("http://u@host:8000", { PROXY_MCP_UPSTREAM_PASSWORD: "s3cret" }),
      "http://u@host:8000",
    );
  });

  it("fills the password slot of a username-only URL", () => {
    assert.equal(
      mergeUpstreamPassword("http://groups-RESIDENTIAL,country-US@proxy.apify.com:8000", at("proxy.apify.com")),
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
      PROXY_MCP_UPSTREAM_HOST: "host",
    });
    assert.equal(new URL(out).host, "host:8000");
    assert.ok(!out.includes("@evil.example"));
  });

  it("survives mockttp's url.parse().auth round-trip", () => {
    // mockttp reads credentials via legacy url.parse().auth (rules/http-agents.js:57),
    // which percent-decodes. Encoding here must therefore be lossless, or a
    // password containing "@" or "/" would authenticate with the wrong value.
    // ":" is excluded deliberately — see the socks test below.
    const secret = "p@ss/word#with?specials";
    const out = mergeUpstreamPassword("http://user@host:8000", {
      PROXY_MCP_UPSTREAM_PASSWORD: secret,
      PROXY_MCP_UPSTREAM_HOST: "host",
    });
    assert.equal(parse(out).auth, `user:${secret}`);
    assert.equal(new URL(out).host, "host:8000");
  });

  it("survives the round-trip with a '%' in the password", () => {
    // The password setter escapes "@" and "/" but not "%", while url.parse()
    // decodeURIComponent()s the auth: a raw "%" made that decode throw, and a
    // raw "%20" decoded to a space. Both must come back byte-identical.
    for (const secret of ["100%pass", "p%20ss", "%"]) {
      const out = mergeUpstreamPassword("http://user@host:8000", {
        PROXY_MCP_UPSTREAM_PASSWORD: secret,
        PROXY_MCP_UPSTREAM_HOST: "host",
      });
      assert.equal(parse(out).auth, `user:${secret}`);
    }
  });

  it("reaches https-proxy-agent intact, including a ':' in the password", () => {
    // https-proxy-agent takes the whole auth string, so ":" is safe here.
    const secret = "pa:ss/word";
    const out = mergeUpstreamPassword("https://user@host:8443", {
      PROXY_MCP_UPSTREAM_PASSWORD: secret,
      PROXY_MCP_UPSTREAM_HOST: "host",
    });
    const auth = parse(out).auth!;
    assert.equal(auth.slice(auth.indexOf(":") + 1), secret);
  });

  it("documents that a socks upstream truncates a password at ':'", () => {
    // socks-proxy-agent@7 does opts.auth.split(":") and takes [1]
    // (mockttp/node_modules/socks-proxy-agent/dist/index.js:78-81), so anything
    // after the first ":" is dropped. This is a pre-existing toolchain limit,
    // not something this merge introduces: a literal socks5://u:pa%3Ass@host
    // truncates identically. Pinned so the restriction is visible, and so this
    // fails if socks-proxy-agent ever starts honouring the full password.
    const out = mergeUpstreamPassword("socks5://user@host:1080", {
      PROXY_MCP_UPSTREAM_PASSWORD: "pa:ss",
      PROXY_MCP_UPSTREAM_HOST: "host",
    });
    assert.equal(parse(out).auth!.split(":")[1], "pa");

    // ...while a socks password with no ":" is delivered whole.
    const ok = mergeUpstreamPassword("socks5://user@host:1080", {
      PROXY_MCP_UPSTREAM_PASSWORD: "p@ss/word",
      PROXY_MCP_UPSTREAM_HOST: "host",
    });
    assert.equal(parse(ok).auth!.split(":")[1], "p@ss/word");
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

describe("upstreamPasswordSource", () => {
  const env = { PROXY_MCP_UPSTREAM_PASSWORD: "s3cret", PROXY_MCP_UPSTREAM_HOST: "host" };
  const source = (url: string, e: NodeJS.ProcessEnv) =>
    upstreamPasswordSource(url, mergeUpstreamPassword(url, e));

  it("reports where the password came from", () => {
    assert.equal(source("http://user@host:8000", env), "env");
    assert.equal(source("http://user:mine@host:8000", env), "url");
    // The case worth reporting: the caller named a user, no password was
    // applied, so the upstream is about to be used username-only.
    assert.equal(source("http://user@host:8000", {}), "none");
    // No username, no question to answer — the field is omitted entirely
    // rather than warning about a correctly unauthenticated upstream.
    assert.equal(source("http://host:8000", env), null);
    assert.equal(source("not a url", env), null);
  });
});
