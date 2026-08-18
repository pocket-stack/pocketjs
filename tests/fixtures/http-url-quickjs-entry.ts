import { canonicalizeHttpUrl } from "../../framework/src/net/http-url.ts";

declare global {
  var __pocketJsHttpUrlHeapProbe: (() => number) | undefined;
}

globalThis.__pocketJsHttpUrlHeapProbe = (): number => {
  const inputs = [
    "https://faß.example:443/a/../雪?q='值'#片段",
    "http://مثال.إختبار/مسار",
    "http://[2001:0DB8:0:0:0:0:0:1]:80/a/%2e%2e/b",
    `https://example.test/${"雪".repeat(800)}`,
  ];
  let checksum = 0;
  for (let round = 0; round < 16; round++) {
    for (let index = 0; index < inputs.length; index++) {
      const parsed = canonicalizeHttpUrl(inputs[index]!);
      checksum += parsed.href.length + parsed.fragment.length + parsed.hostname.length;
    }
  }
  return checksum;
};
