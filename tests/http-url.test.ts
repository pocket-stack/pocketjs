import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { URL as PocketURL } from "../framework/src/net/index.ts";
import {
  canonicalizeHttpUrl,
  HTTP_URL_HOST_CODE_UNITS_LIMIT,
  HTTP_URL_INPUT_CODE_UNITS_LIMIT,
  HTTP_URL_PATH_SEGMENT_LIMIT,
} from "../framework/src/net/http-url.ts";
import { domainToAscii } from "../framework/src/net/vendor/url/tr46.ts";
import {
  renderTr46Data,
  renderTr46Regexes,
} from "../tools/generate-url-idna-table.ts";

const WPT_SNAPSHOT = "6437d68e10721ed4b9b68101ec1ab1a1b67a3995";
const WPT_URLTESTDATA_SHA256 =
  "355c9f1e5f34aae66ba8adfabf3c853f5cd30ea22964ef7a53eb292e7975d81e";

function serialized(input: string): string {
  const parsed = canonicalizeHttpUrl(input);
  return `${parsed.href}${parsed.fragment}`;
}

describe("bounded HTTP WHATWG URL profile", () => {
  test("ports selected cases from the pinned WPT urltestdata snapshot", () => {
    expect(WPT_SNAPSHOT).toHaveLength(40);
    expect(WPT_URLTESTDATA_SHA256).toHaveLength(64);
    const cases: readonly (readonly [string, string])[] = [
      ["http://example\t.\norg", "http://example.org/"],
      ["http://f:21/ b ? d # e ", "http://f:21/%20b%20?%20d%20#%20e"],
      ["http://f:0/c", "http://f:0/c"],
      ["http://f:00000000000000000000080/c", "http://f/c"],
      ["http://example.com/foo/%2e", "http://example.com/foo/"],
      ["http://example.com/foo/%2e%2", "http://example.com/foo/%2e%2"],
      [
        "http://example.com/foo/%2e./%2e%2e/.%2e/%2e.bar",
        "http://example.com/%2e.bar",
      ],
      ["https://example.com/aaa/bbb/%2e%2e?query", "https://example.com/aaa/?query"],
      ["https://faß.ExAmPlE/", "https://xn--fa-hia.example/"],
      ["http://example.com/你好你好", "http://example.com/%E4%BD%A0%E5%A5%BD%E4%BD%A0%E5%A5%BD"],
      ["http://你好你好", "http://xn--6qqa088eba/"],
      ["http://www.foo。bar.com", "http://www.foo.bar.com/"],
      ["http://example.com\\\\foo\\\\bar", "http://example.com//foo//bar"],
      ["http://[2001::1]", "http://[2001::1]/"],
      ["http://[::127.0.0.1]", "http://[::7f00:1]/"],
      ["http://[0:0:0:0:0:0:13.1.68.3]", "http://[::d01:4403]/"],
      ["http://[2001::1]:80", "http://[2001::1]/"],
      ["http://192.0x00A80001", "http://192.168.0.1/"],
      ["http://0xffffffff", "http://255.255.255.255/"],
      ["https://0x.0x.0x.0x", "https://0.0.0.0/"],
      ["http://foo:80/", "http://foo/"],
      ["http://foo:81/", "http://foo:81/"],
      ["https://foo:443/", "https://foo/"],
      ["https://foo:80/", "https://foo:80/"],
    ];
    for (const [input, expected] of cases) expect(serialized(input)).toBe(expected);
  });

  test("normalizes UTS 46 labels with bidi and ContextJ validation", () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ["CAFÉ.example", "xn--caf-dma.example"],
      ["faß.de", "xn--fa-hia.de"],
      ["βόλος.com", "xn--nxasmm1c.com"],
      ["مثال.إختبار", "xn--mgbh0fb.xn--kgbechtv"],
      ["עברית.example", "xn--5dbqzzl.example"],
      ["क्‍ष.example", "xn--11b2ezcw70k.example"],
      ["ＥＸＡＭＰＬＥ.com", "example.com"],
      ["☃.com", "xn--n3h.com"],
      ["xn--fa-hia.de", "xn--fa-hia.de"],
      ["a‌b.example", null],
      ["xn--", null],
      ["́a.example", null],
      ["a_b.example", null],
    ];
    for (const [input, expected] of cases) expect(domainToAscii(input)).toBe(expected);
  });

  test("canonicalizes legacy IPv4, IPv6, path, query, and fragment forms", () => {
    expect(serialized("HTTP://EXAMPLE.TEST:80/a/./b/../c?q='雪'#a b`雪"))
      .toBe("http://example.test/a/c?q=%27%E9%9B%AA%27#a%20b%60%E9%9B%AA");
    expect(serialized("http://127.1/")).toBe("http://127.0.0.1/");
    expect(serialized("http://0x7f.1/")).toBe("http://127.0.0.1/");
    expect(serialized("http://[2001:0DB8:0:0:0:0:0:1]:80/"))
      .toBe("http://[2001:db8::1]/");
    expect(serialized("http://example.test/%zz#")).toBe("http://example.test/%zz#");
    expect(canonicalizeHttpUrl("http://example.test/#")).toMatchObject({
      href: "http://example.test/",
      hasFragment: true,
      fragment: "#",
      hostname: "example.test",
    });
  });

  test("applies PocketJS endpoint and credential safety deviations", () => {
    expect(serialized("http://example.test./")).toBe("http://example.test/");
    expect(serialized("http://example。test。/")).toBe("http://example.test/");
    for (const input of [
      "http://user@example.test/",
      "http://:@example.test/",
      "http://-bad.example/",
      "http://bad-.example/",
      "http://bad_name.example/",
      "http://example.test../",
      "http://xn--/",
    ]) {
      expect(() => canonicalizeHttpUrl(input), input).toThrow(TypeError);
    }
  });

  test("accepts only absolute HTTP(S) values", () => {
    for (const input of [
      "./relative",
      "example.test/path",
      "ftp://example.test/",
      "ws://example.test/",
      "http://",
      "https://?query",
      "http://[::::]/",
      "http://example.test:65536/",
      "http://09/",
      "http://4294967296/",
    ]) {
      expect(() => canonicalizeHttpUrl(input), input).toThrow(TypeError);
    }
  });

  test("enforces input, host, output, and path-segment ceilings", () => {
    expect(() => canonicalizeHttpUrl("x".repeat(HTTP_URL_INPUT_CODE_UNITS_LIMIT + 1)))
      .toThrow(/input safety ceiling/);
    expect(() => canonicalizeHttpUrl(
      `http://${"a".repeat(HTTP_URL_HOST_CODE_UNITS_LIMIT + 1)}/`,
    )).toThrow(/hostname exceeds/);
    expect(() => canonicalizeHttpUrl(`http://${"a".repeat(64)}.test/`))
      .toThrow(/IDNA hostname/);
    expect(() => canonicalizeHttpUrl(`http://example.test/${"雪".repeat(1000)}`))
      .toThrow(/serialization exceeds/);
    expect(() => canonicalizeHttpUrl(
      `http://example.test/${"/".repeat(HTTP_URL_PATH_SEGMENT_LIMIT + 1)}`,
    )).toThrow(/path-segment/);
  });

  test("public URL snapshots canonical href and is frozen", () => {
    const url = new PocketURL(" HTTPS://CAFÉ.TEST:443/a/../b#雪 ");
    expect(url.href).toBe("https://xn--caf-dma.test/b#%E9%9B%AA");
    expect(url.toString()).toBe(url.href);
    expect(url.toJSON()).toBe(url.href);
    expect(Object.isFrozen(url)).toBe(true);
    expect(new PocketURL(url).href).toBe(url.href);
  });

  test("keeps permission-relevant normalization on captured intrinsics", () => {
    const result = Bun.spawnSync([
      "bun",
      "tests/fixtures/http-url-hostile-intrinsics.ts",
    ], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("");
  });
});

describe("pinned IDNA generated data", () => {
  test("matches the vendored tr46 6.0.0 source byte-for-byte", () => {
    const mapping = readFileSync("tools/vendor/tr46-6.0.0/mappingTable.json", "utf8");
    const regexes = readFileSync("tools/vendor/tr46-6.0.0/regexes.js", "utf8");
    expect(renderTr46Data(mapping)).toBe(
      readFileSync("framework/src/net/vendor/url/idna-data.generated.ts", "utf8"),
    );
    expect(renderTr46Regexes(regexes)).toBe(
      readFileSync("framework/src/net/vendor/url/idna-regexes.generated.ts", "utf8"),
    );
  });
});
