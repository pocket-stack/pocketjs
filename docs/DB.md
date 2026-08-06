# The DB Module

DB is PocketJS's fourth module (after `ui`, `strike` and `audio`): SQLite
mounted as `globalThis.db` behind five synchronous ops. Like audio it was
written spec-first — the boundary existed before any host code, every host
implements the same pinned protocol, and a developer adding a data feature
extends the spec instead of forking a host. `contracts/spec/db.ts` is
normative; this page is the map.

```
platform storage (POSIX file · LittleFS · memory)              Host / substrate
    ↑ SQLite's own VFS is the port point
db core: SQLite + handle table + statement cache               the module
db spec: ops (open, close, exec, query, lastError)
         events (none — every op is synchronous)
         data contract (JSON value encoding · name rules · ceilings)
         frame contract (no module clock; ops complete in the guest turn)
SDK: @pocketjs/framework/db (Database, Statement — the bun:sqlite shape)
    ↓
app: schema in exec(), rows out of query(), state in tables    Guest
```

## The boundary in one page

**Mount.** The module is its own namespace: `globalThis.db`, one method per
op (`DB_OP` codes are the ABI identity, append-only). Capability id
`data.sqlite`. Unlike audio, absence does **not** degrade to a no-op — data
code that silently drops writes is a corruption bug, so the SDK throws where
the namespace is unmounted, and an app declares `data.sqlite` in
`pocket.json` `requires` so admission catches the gap before eval does.

**Ops** (guest → core, all synchronous): `open(name)` → handle,
`close(handle)`, `exec(handle, sql)` → 0/1 for schema and migrations,
`query(handle, sql, argsJson)` → one JSON line
(`{cols, rows, changes, lastInsertRowid}` or `{error}`), and
`lastError(handle)`. Statement caching is **host-side**, keyed by the sql
string — the guest holds no statement handles, so there is nothing to
finalize and nothing to leak.

**Values** cross as JSON: NULL ↔ `null`, INTEGER ↔ number, REAL ↔ number,
TEXT ↔ string, BLOB ↔ `{"$b": "<base64>"}`. Integers beyond 2^53 − 1 and
non-finite REALs **fail the op** instead of losing precision silently —
store money in cents. Booleans bind as 1/0; integer-valued numbers bind as
INTEGER, fractional as REAL (the bun:sqlite convention).

**Storage rule.** `open(name)` is the only path to a database: names are
filename-safe tokens (`DB_NAME_PATTERN`) or `:memory:`, and the host maps a
name to a real file under the app's own data root. The guest never sees a
path. `ATTACH` — the one SQL statement that names a file — is refused
(engine/crates/pocket-db uses a real SQLite authorizer), and
`load_extension` stays disabled, so the data root stays the sandbox
boundary.

**Ceilings.** `DB_MAX_DATABASES` (4) open handles; `DB_MAX_RESULT_ROWS`
(4096) rows per `query()` call, above which the op fails with "add LIMIT or
aggregate" — an unbounded SELECT on a device heap is a bug surfaced early,
not a workload.

**Frame contract.** The module owns no clock and emits no events: every op
completes inside the guest's single per-tick turn (law 3 unchanged). SQL
time and randomness resolve host-side — deterministic hosts pin them, and a
golden-tested app must not depend on `random()` or 'now'-relative SQL, the
same rule as `Date.now` in guest code.

## The SDK

`@pocketjs/framework/db` is the bun:sqlite shape, so code written against
Bun's built-in SQLite runs against the mounted module unchanged:

```ts
import { Database } from "@pocketjs/framework/db";

const db = new Database("portfolio");
db.exec(`CREATE TABLE IF NOT EXISTS history (
  bucket TEXT PRIMARY KEY, total_cents INTEGER NOT NULL
)`);

const insert = db.query("INSERT OR REPLACE INTO history VALUES ($bucket, $cents)");
const record = db.transaction((bucket: string, cents: number) => {
  insert.run({ $bucket: bucket, $cents: cents });
});
record("2026-08-06T14:35", 1_532_042);

db.query("SELECT * FROM history ORDER BY bucket DESC LIMIT 288").all();
```

`query()` returns a cached `Statement` (`.get/.all/.values/.run`);
`prepare()` skips the cache; `transaction(fn)` wraps BEGIN/COMMIT with
ROLLBACK on throw and nests as savepoints — batching writes into one
transaction is also the flash-wear discipline on device hosts.

## Host status

| Host | Implementation | Status |
|---|---|---|
| sim (`hosts/sim/db.ts`) | bun:sqlite behind the op namespace, injected via `bootWorld` `extraGlobals` | ships with the test host; `tests/db.test.ts` runs the contract and an oracle comparison against bun:sqlite directly |
| reference core (`engine/crates/pocket-db`) | rusqlite (bundled SQLite) + the ATTACH authorizer, mountable on any `pocket-mod` guest as `globalThis.db` | tested including a live QuickJS guest round-trip |
| consoles / devices | — | a target appends `data.sqlite` to its profile when its native host ships the module; the port point is SQLite's VFS (POSIX on desktop, LittleFS-backed on MCU hosts) |

## Adoption path

A device host that wants the module makes three moves, none of which touch
the spec, the SDK, or any app:

1. compile SQLite with the platform toolchain and register a VFS for the
   platform filesystem (the desktop default VFS already serves
   `Storage::Dir`);
2. mount the namespace beside `ui` — `pocket_db::mount(&guest, module)` on
   `pocket-mod` hosts, or the raw-QuickJS spelling of the same five
   functions elsewhere;
3. append `data.sqlite` to the target's profile in
   `contracts/spec/platforms.ts`.
