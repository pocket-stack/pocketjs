# Symbian Pocket

PocketJS TSX application for the ESP32-WROVER-B handheld host in
`hosts/esp32`. The visual direction follows classic S60 3rd Edition: blue
status chrome, compact title and softkey bars, a wrapped icon grid, modal
menus, bilingual labels, and short menu transitions sized for a 160×128
display.

The two-page launcher contains Contacts, Messages, Calendar, Alarms, Notes,
Calculator, Files, Gallery, Tones, Snake, Connectivity, Sensors, Hardware,
and Settings.

Run the deterministic model tests with:

```powershell
bun test apps/symbian-pocket/model.test.ts
```

Build the guest bundle and PAK with:

```powershell
bun tools/build.ts symbian-pocket-main `
  --font-regular=hosts/esp32/build/fonts/SimHei-SymbianPocket.ttf `
  --font-bold=hosts/esp32/build/fonts/SimHei-SymbianPocket.ttf `
  --outdir=hosts/esp32/build/assets
```
