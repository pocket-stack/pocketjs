# tr46 6.0.0 source snapshot

`mappingTable.json` and `regexes.js` are unmodified files from the npm
`tr46@6.0.0` tarball. They describe Unicode 17.0.0 UTS #46 processing data.

- Source: https://registry.npmjs.org/tr46/-/tr46-6.0.0.tgz
- Tarball SHA-256: `8737146639e92140a7bf77090b8a09539ec7610b60fcf9a412567cb7280e2881`
- `mappingTable.json` SHA-256: `c45bd284e01f0845bc3c3b1d7594cd7b9ee8b955ddc850882b8e1dc5d0cba95d`
- `regexes.js` SHA-256: `3f43551d5109e5a300b29d5a9c261adf2bfd1621ffc086909f8ebf40835fc70f`
- License: MIT; the upstream notice is retained in `LICENSE.md`.

`tools/generate-url-idna-table.ts` converts the mapping table into a
fixed-width base64 record string. Runtime lookup decodes one six-byte record
at a time and never expands the 9,262 source rows into JS objects.
