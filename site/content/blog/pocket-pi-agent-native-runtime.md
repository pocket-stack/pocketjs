<svg viewBox="0 0 760 420" width="100%" role="img" aria-label="Pocket Pi AgentOS architecture. A resident Pi Agent System App owns the workspace and uses an App Tool Router to work with Exa and Robinhood Apps. Each App contains Tools, Data Actions, SQLite state and a fixed PocketJS View. PocketJS UI, net, fs and db modules connect those Apps to macOS or ESP32-P4 host adapters." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="420" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">Pocket Pi AgentOS — one Agent, many local Apps</text>
  <rect x="218" y="52" width="324" height="76" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="380" y="78" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pi Agent · resident System App</text>
  <text x="380" y="99" fill="#94a3b8" font-size="11" text-anchor="middle">Agent Loop + Root View · owns /workspace</text>
  <text x="380" y="116" fill="#94a3b8" font-size="11" text-anchor="middle">keeps running while another App is foreground</text>
  <line x1="380" y1="128" x2="380" y2="158" stroke="#475569" stroke-width="1.5"/>
  <rect x="246" y="158" width="268" height="48" rx="9" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="179" fill="#f1f5f9" font-size="12" text-anchor="middle">App Supervisor · Tool Router</text>
  <text x="380" y="196" fill="#94a3b8" font-size="10" text-anchor="middle">lifecycle · schedules · revisions · ownership</text>
  <line x1="300" y1="206" x2="190" y2="236" stroke="#475569" stroke-width="1.5"/>
  <line x1="460" y1="206" x2="570" y2="236" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="236" width="332" height="92" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="190" y="260" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Exa App</text>
  <text x="190" y="282" fill="#94a3b8" font-size="11" text-anchor="middle">Tools → Data Actions → SQLite</text>
  <text x="190" y="302" fill="#94a3b8" font-size="11" text-anchor="middle">fixed research View · bounded history</text>
  <text x="190" y="319" fill="#64748b" font-size="10" text-anchor="middle">fetch() through PocketJS NET</text>
  <rect x="404" y="236" width="332" height="92" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="570" y="260" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Robinhood App</text>
  <text x="570" y="282" fill="#94a3b8" font-size="11" text-anchor="middle">Tools → Data Actions → SQLite</text>
  <text x="570" y="302" fill="#94a3b8" font-size="11" text-anchor="middle">fixed portfolio View · local Schedule</text>
  <text x="570" y="319" fill="#64748b" font-size="10" text-anchor="middle">MCP through native credential boundary</text>
  <line x1="190" y1="328" x2="190" y2="350" stroke="#475569" stroke-width="1.5"/>
  <line x1="570" y1="328" x2="570" y2="350" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="350" width="712" height="46" rx="9" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="380" y="371" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS modules · UI · NET · FS · DB</text>
  <text x="380" y="388" fill="#94a3b8" font-size="10" text-anchor="middle">portable contracts → macOS simulator or ESP32-P4 host adapters</text>
</svg>

The [first Pocket Pi port](/blog/pocket-pi-on-esp32-p4/) answered a fairly unreasonable question: could a complete Pi coding agent live on an ESP32-P4, with its loop, tools, schedules, files and interface on the board rather than behind a remote screen? The answer was yes. That post ended with one deliberately unfulfilled sentence: Apps as tools-plus-a-view were the obvious continuation, and we would write about them when they were real.

They are real now ([Pocket Pi PR #11](https://github.com/pocket-stack/pocket-pi/pull/11)). The work started as “put Exa and Robinhood on the device” and became a redesign of the runtime underneath them. We did not want two more features welded into firmware. We wanted a definition of App that made sense to an Agent, to a human and to a 32 MB board at the same time.

This post is about that architecture: what the first Pocket Pi still got wrong, what we mean by an agent-native runtime, why the data layer became the center of the system, and how PocketJS makes the result portable without hiding the constraints of the ESP32-P4.

## What Pocket Pi was

The first port was deliberately direct. QuickJS ran the embedded `pi-agent-core` bundle. Native Rust supplied everything the board lacked: workspace tools over LittleFS, schedules, model transports, bounded shell-like operations, Wi-Fi, credentials, touch, display and the product UI. That was exactly the right shape for proving that the Agent really lived on the board.

It was also still heavy on Rust firmware.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-esp32-hero.png" alt="The original Pocket Pi device UI, implemented as a native Rust product surface, showing Agent chat, schedules, the LittleFS workspace browser and a file reader." />

The Agent loop was TypeScript, but the product around it was native. Rust owned the screen state, file browser, schedule panels, input handling and composition of every device capability. The boundary was roughly “Agent in JavaScript, product in firmware.”

That boundary gave the first version a useful property: there were very few moving parts. A native Tool could talk directly to LittleFS or a board service; a native screen could render the result; the firmware knew every possible state. For a proof, this was an advantage. The device could demonstrate Agent turns, file writes, autonomous wakes and persistence without first inventing an application platform.

The cost appeared as soon as we tried to add complete products. A Robinhood experience is not one Tool. It has Agent-facing capabilities, provider mapping, a refresh cadence, durable portfolio state and a View. Exa has the same categories with a different protocol and data model. If all of those pieces live in Rust, every new App expands the trusted firmware, adds another product-specific state machine, and requires another firmware release.

The original Pocket Pi therefore proved that an Agent could run on embedded hardware, but it did not yet prove that software could expand around that Agent. The Agent was portable TypeScript. The products it could use were not.

## The problem with the old architecture

The problem was not that Rust is the wrong language. Hardware drivers, TLS, credential storage and resource limits are exactly where we want a small trusted native layer. The problem was that the native layer also owned product meaning.

That created four architectural limits.

First, **a Tool was not an App**. A Tool schema tells the model how to invoke an operation. It does not define the durable state produced by that operation, the background work associated with it, or the human View that explains its result. Treating Apps as a flat list of Tools leaves every other product concern without an owner.

Second, **the Agent and the interface had no explicit relationship**. If navigation is just another firmware screen state, opening an App can accidentally become part of the Agent's lifecycle. But the Agent may be waiting for a model, running a Tool or updating its workspace while the user moves elsewhere. Foreground selection and Agent lifetime have to be separate concepts.

Third, **product expansion required core changes**. A provider-specific schema, a new screen and a new refresh rule all flowed into firmware. That is the opposite of an App platform: the stable mechanism layer keeps learning the meaning of every product it hosts.

Fourth, **portability stopped at the Agent**. The Agent loop could move because it ran inside QuickJS. The surrounding product logic was tied to the ESP32 composition. A simulator could imitate it, but another board still needed product-specific native work rather than one implementation of a shared runtime contract.

### What agent-native means

We use **agent-native runtime** narrowly. It does not mean putting a chat box in every App, asking a model to generate every screen, or giving an Agent coordinates to click. It means that the runtime's unit of software matches the way an Agent acts.

Three core concepts fell out of that definition.

1. **An App is Agent-facing capability, App-owned state and a human-facing fixed View in one versioned unit.** The Agent sees semantic Tools. The human sees a stable product interface. Both belong to the same App and both are backed by the same local state.
2. **State is the only coordination surface between capability and View.** Agent Tools, App Schedules and human actions enter the same Data Actions. A successful action changes durable state. The View projects that state; neither the Agent nor the Data Action pushes presentation into the View.
3. **The Agent decides why and when; the App deterministically owns how, what to save and how to display it.** A recurring refresh does not need a model turn. Provider decoding does not belong in Agent reasoning. The Agent composes Apps; it is not the implementation of every App.

This makes the Agent/App relationship much clearer. An App exposes meaningful operations rather than UI controls. The Agent can combine those operations across products and use its workspace for memory, plans and context. The App keeps its provider protocol, tables and presentation private. A human and an Agent can work with the same product without pretending they have the same interface.

It also makes **the Agent itself an App**, but a special one. Pi Agent has code, state and a Root View like other Apps; unlike them, it owns the top-level `/workspace`, sees the cross-App Tool Catalog and stays resident for the lifetime of the system. “Agent as App” gives its loop and View one release boundary. “System App” gives it the ownership and lifecycle required to orchestrate everything else.

Finally, agent-native Apps must be expandable and transportable. Expandable means a new product can bring its Tools, Data Actions, schema and View without adding that product's meaning to firmware. Transportable means the same App source can run anywhere the required PocketJS and AgentOS capabilities exist. It does not mean one byte-identical binary on every board: assets, viewport and ABI can still produce target-specific artifacts. The contract is portable; the hardware remains real.

## The new Pocket Pi architecture

The new runtime has four layers. The design is less about where a file sits than about which layer is allowed to know what.

<svg viewBox="0 0 760 535" width="100%" role="img" aria-label="Four-layer Pocket Pi architecture. App bundles at the top contain descriptors, Tools, Data Actions, SQLite schemas and Views. Pocket Pi AgentOS below provides the System App lifecycle, App Supervisor, Tool Router, scheduler, Data Action runner and revision delivery. PocketJS provides QuickJS Guests, bundles, UI and net, fs and db module contracts. Native host adapters at the bottom provide macOS or ESP32-P4 display, touch, LittleFS, SQLite, TLS, credentials, MCP and model transport." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="535" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">product meaning stays high; hardware policy stays low</text>
  <rect x="24" y="52" width="712" height="112" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="44" y="77" fill="#34d399" font-size="12" font-weight="700">APP BUNDLES</text>
  <text x="44" y="101" fill="#f1f5f9" font-size="12">pi-agent · Exa · Robinhood</text>
  <text x="44" y="124" fill="#94a3b8" font-size="11">agent-app.json · public Tool schemas · private Data Actions · SQLite schema</text>
  <text x="44" y="145" fill="#94a3b8" font-size="11">provider mapping · fixed PocketJS View · assets</text>
  <line x1="380" y1="164" x2="380" y2="186" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="186" width="712" height="112" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="44" y="211" fill="#38bdf8" font-size="12" font-weight="700">POCKET PI AGENTOS</text>
  <text x="44" y="235" fill="#f1f5f9" font-size="12">resident System App · App Supervisor · Tool Catalog / Router</text>
  <text x="44" y="258" fill="#94a3b8" font-size="11">AppTask schedules · headless Data Action execution · App ownership</text>
  <text x="44" y="279" fill="#94a3b8" font-size="11">revision delivery · foreground selection · resource policy</text>
  <line x1="380" y1="298" x2="380" y2="320" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="320" width="712" height="88" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="44" y="345" fill="#a78bfa" font-size="12" font-weight="700">POCKETJS</text>
  <text x="44" y="369" fill="#f1f5f9" font-size="12">QuickJS Guest · TS/TSX bundle · retained UI · DrawList</text>
  <text x="44" y="390" fill="#94a3b8" font-size="11">portable module contracts: UI · NET / fetch · FS · DB / SQLite</text>
  <line x1="380" y1="408" x2="380" y2="430" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="430" width="342" height="80" rx="10" fill="#111827" stroke="#64748b" stroke-width="1.5"/>
  <text x="195" y="457" fill="#f1f5f9" font-size="12" text-anchor="middle">macOS simulator host</text>
  <text x="195" y="480" fill="#94a3b8" font-size="11" text-anchor="middle">window · input · files · SQLite · HTTP</text>
  <text x="195" y="498" fill="#64748b" font-size="10" text-anchor="middle">same embedded AgentOS contract</text>
  <rect x="394" y="430" width="342" height="80" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="565" y="457" fill="#f1f5f9" font-size="12" text-anchor="middle">ESP32-P4 host</text>
  <text x="565" y="480" fill="#94a3b8" font-size="11" text-anchor="middle">LCD · touch · LittleFS · SQLite · TLS · NVS</text>
  <text x="565" y="498" fill="#64748b" font-size="10" text-anchor="middle">credentials · MCP · model transport · limits</text>
</svg>

At the bottom, the **native Host** owns hardware, secrets and scarce resources: display and touch drivers, filesystem mounts, TLS, credentials, MCP sessions, model transport, clocks and limits. Native does not mean product-specific. The Host knows how to make an authenticated bounded request; it does not know what an Exa result means or how a Robinhood portfolio should look.

Above it, **PocketJS** supplies the portable application floor: isolated QuickJS Guests, compiled TypeScript/TSX bundles, retained UI, and module contracts for networking, files and SQLite. PocketJS deliberately does not know that Pi Agent owns `/workspace`, which App is foreground or which App owns a Tool. Those are Pocket Pi product semantics, not universal JavaScript-runtime rules.

**Pocket Pi AgentOS** adds those semantics. `AppSupervisor` owns System and ordinary App lifecycles. The Tool Catalog and Router establish which App owns which capability. The Scheduler distinguishes a model-starting Agent wake from an App task that can run deterministically without the model. The Data Action runner keeps slow work away from the View. Revision delivery tells a foreground View that newer committed state exists.

At the top, **App bundles** own product meaning. The current bundle shape makes the boundary concrete:

| Artifact | Architectural role |
| --- | --- |
| `agent-app.json` | identity, Public Tool schemas, Tasks, Schedules and required capabilities |
| `data-action.js` | private Data Actions, provider mapping, normalization and SQLite writes |
| `app.js` + `app.pak` | the fixed PocketJS View and its assets |
| `<app>.sqlite` | durable App-owned product state |

“Fixed View” means fixed for one App release, not hardcoded in firmware. It can evolve with the bundle. It is fixed in the other direction: the Agent does not invent it on every turn, and Data Actions cannot bypass the data layer to push arbitrary presentation into it. That gives the human a stable interface and gives the App author a bounded target to design and test.

### Agent as a resident System App

Pi Agent's `agent.js` and Root View `app.js` run in the same PocketJS Guest. `AppSupervisor` creates that System App once and keeps it resident. Opening Exa or Robinhood changes only which View produces the foreground DrawList and receives touch input.

This design follows from the Agent's role. The Agent owns long-lived conversation, context, pending model and Tool work, workspace files, memory and system-level schedules. None of those should be scoped to the screen currently visible. If opening another App rebuilt the Agent Guest, foreground navigation would silently become a context-reset operation.

Ordinary Apps have a narrower boundary. Their filesystem and SQLite mounts are App-scoped. They can expose Tools to Pi Agent, run their own local Tasks and display their own View, but they do not gain access to another App's data or the top-level workspace. The special privilege belongs to the System App, not to every QuickJS Guest.

This also resolves an apparent tension in “Agent as App.” Pi Agent participates in the same bundle and View model, so its behavior can evolve as code rather than firmware. It remains system-level because its lifetime, workspace mount and Tool Catalog scope are different. Common packaging does not require equal authority.

### Apps as portable product units

An ordinary App has two execution planes. The **data plane** runs Tools, local Tasks and provider work, then commits SQLite. The **view plane** reads a bounded projection of that state and renders it with PocketJS. They may use separate QuickJS execution contexts so slow network work never becomes View work, but they still belong to one App, share one state owner and version together.

This is the unit that can expand Pocket Pi. Adding an App should require a descriptor, its Data Actions, schema, View and assets. The AgentOS runtime admits the declared capabilities, registers Tools and Schedules, mounts storage and manages lifecycle. The Host does not acquire a new product-specific screen or response parser.

The same unit is what can move to another device. A new host implements PocketJS modules and the AgentOS lifecycle contracts once. Compatible Apps then reuse their product source and state model. A different viewport may produce a different View artifact, and a different ABI may produce a different bundle, but the App does not acquire board-specific business logic.

### State, not screens: separating Data from View

This is the core of the architecture.

We started from four first-principles observations.

1. **An action can outlive a View.** An Agent Tool or local Schedule may finish while the App is in the background, before its View has ever opened, or across a reboot. A visible component tree cannot be the durable destination of that work.
2. **The Agent and the human are two clients of one product.** If Agent actions update one state path and UI actions update another, the App has two implementations of its business rules and two versions of reality.
3. **Durable state is inspectable and recoverable; presentation is not.** SQLite can survive power loss, support bounded queries and be read by a new View release. A sequence of imperative View updates cannot reconstruct product truth reliably.
4. **Presentation changes more often than meaning.** The same portfolio state can support a small embedded screen, a simulator window or a future device layout. Provider responses and Agent reasoning should not dictate those representations.

Those observations give the App one dependency direction:

<svg viewBox="0 0 760 400" width="100%" role="img" aria-label="The Pocket Pi App data flow. Agent Tool, local App Schedule and human UI Action converge on one Data Action. The Data Action uses native capabilities, normalizes a complete response, commits one SQLite transaction and increments an App revision. At the next foreground frame the View compares revisions, performs one bounded query if stale, updates its memory cache and renders. Background Apps and unchanged frames perform no SQLite queries." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="400" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">three initiators · one write path · one durable truth</text>
  <rect x="24" y="60" width="170" height="50" rx="9" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="109" y="90" fill="#f1f5f9" font-size="12" text-anchor="middle">Agent Tool</text>
  <rect x="24" y="126" width="170" height="50" rx="9" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="109" y="156" fill="#f1f5f9" font-size="12" text-anchor="middle">local App Schedule</text>
  <rect x="24" y="192" width="170" height="50" rx="9" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="109" y="222" fill="#f1f5f9" font-size="12" text-anchor="middle">human UI Action</text>
  <line x1="194" y1="85" x2="248" y2="151" stroke="#475569" stroke-width="1.5"/>
  <line x1="194" y1="151" x2="248" y2="151" stroke="#475569" stroke-width="1.5"/>
  <line x1="194" y1="217" x2="248" y2="151" stroke="#475569" stroke-width="1.5"/>
  <rect x="248" y="111" width="202" height="80" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="349" y="138" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Data Action</text>
  <text x="349" y="159" fill="#94a3b8" font-size="11" text-anchor="middle">native capability · decode · normalize</text>
  <text x="349" y="177" fill="#94a3b8" font-size="11" text-anchor="middle">one business implementation</text>
  <line x1="450" y1="151" x2="492" y2="151" stroke="#475569" stroke-width="1.5"/>
  <rect x="492" y="111" width="244" height="80" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="614" y="138" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">SQLite transaction</text>
  <text x="614" y="159" fill="#94a3b8" font-size="11" text-anchor="middle">COMMIT · then App revision++</text>
  <text x="614" y="177" fill="#94a3b8" font-size="11" text-anchor="middle">durable App-owned state</text>
  <line x1="614" y1="191" x2="614" y2="232" stroke="#475569" stroke-width="1.5"/>
  <rect x="402" y="232" width="334" height="94" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="569" y="258" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">foreground fixed View</text>
  <text x="569" y="280" fill="#94a3b8" font-size="11" text-anchor="middle">revision changed? → bounded SQLite projection</text>
  <text x="569" y="300" fill="#94a3b8" font-size="11" text-anchor="middle">memory cache → render</text>
  <text x="569" y="317" fill="#64748b" font-size="10" text-anchor="middle">unchanged frame or background App → zero queries</text>
  <rect x="24" y="286" width="316" height="64" rx="9" fill="#111827" stroke="#64748b" stroke-width="1.5"/>
  <text x="182" y="311" fill="#f1f5f9" font-size="11" text-anchor="middle">Tool result → Agent</text>
  <text x="182" y="331" fill="#94a3b8" font-size="10" text-anchor="middle">only App-owned facts need local persistence</text>
  <line x1="349" y1="191" x2="182" y2="286" stroke="#475569" stroke-width="1.5"/>
  <text x="24" y="379" fill="#64748b" font-size="11">revision is invalidation, not another copy of the data</text>
</svg>

The Agent calls a semantic Tool. The Tool Router sends it to the App that owns it. A local Schedule or a human action can enter the same Data Action. That Data Action uses native capabilities, decodes the provider response, normalizes product values and writes one SQLite transaction. Only after the transaction commits does the App publish a new revision.

The revision is deliberately not the data. It is a small invalidation signal that says a newer committed state exists. If the App is foreground, the View re-queries the bounded projection it needs and updates its memory cache. If the App is in the background, no View query runs. When it opens later, it reads the latest committed state once.

This is why the Agent never calls `update_view`. Asking the model to synchronize presentation would create a second state protocol: the system would need to order Agent updates against Schedules and human actions, persist them for closed Views, replay them after reboot and translate them across different hardware layouts. Those are all problems we avoid by making state the contract and View a projection.

It also means we do not persist every Tool payload. A Tool result can return directly to the Agent while the App stores only the domain facts its fixed View and future actions own. Exa can keep a bounded search-history projection without archiving every fetched document. Robinhood can store normalized portfolio state without turning SQLite into a cache of arbitrary provider JSON. The data model describes the product, not the transport.

The state boundary is what makes background autonomy possible without making the model the operating system for every task. A five-minute App refresh can run locally, commit state and update the next View without waking the Agent. The Agent remains responsible for judgment and cross-App composition; deterministic product maintenance stays inside the App.

### How the architecture maps to the code

| Architecture concept | Current implementation |
| --- | --- |
| Resident Agent System App | `apps/pi-agent/agent.js` and `app.js` share the System Guest owned by `AppSupervisor` |
| Ordinary App release | `apps/exa` and `apps/robinhood` each contain `agent-app.json`, `data-action.js`, View bundle and App assets |
| Public capability ownership | `AppCatalog` reads descriptors; `RoutedToolHost` routes namespaced Tools to the owning App |
| Background product work | `AppDataRunner` executes App Data Actions outside the foreground View path |
| Durable state and View invalidation | one App-scoped `DbModule` owner plus a monotonic App revision delivered as `dataChanged` |
| Autonomous local work | `AppScheduleStore` routes `AppTask` schedules into the same Data Actions without a model turn |
| Hardware boundary | simulator and ESP32 hosts implement filesystem, SQLite, network, credentials, model, display and input adapters |

The names are implementation details; the ownership is the architecture. A future Supervisor can discover Apps dynamically or load Views lazily without changing the rule that Tools and Schedules enter Data Actions, Data Actions commit App state, and Views project it.

## Optimizing the experience on ESP32

Moving product code out of Rust is useful only if the new boundary fits the board. PocketJS gives Pocket Pi a set of portable, bounded modules so App code can stay high-level while the ESP32 host retains control of resources.

### NET: standard App code, native transport policy

At the App boundary, Exa uses `fetch()` from PocketJS. The App chooses its endpoint, request shape and domain decoding. Below that API, the ESP32 Host owns DNS, TLS, HTTP, API-key injection, endpoint policy, timeouts and response limits.

This separation does two things. It keeps credentials and board networking out of the Bundle, and it keeps Exa semantics out of firmware. A macOS simulator can provide another transport adapter behind the same PocketJS contract. The App still sees `fetch`; the Host still gets to enforce what a 32 MB device can safely receive.

Robinhood uses a native MCP capability rather than plain fetch, but the ownership rule is identical. Native code owns authentication, sessions, framing and limits. The App owns which operations make sense, how responses become domain state and which parts appear in the View.

### FS: isolation begins at the mount

PocketJS FS presents paths relative to an App's mounted root. Pocket Pi uses that to express ownership physically: Pi Agent receives the top-level `/workspace`; an ordinary App receives only its own data tree.

SQLite databases are files inside those scoped roots. The physical database isolation therefore begins with the FS mount, while the DB module adds SQLite operations and ownership on top. This is why FS and DB are separate capabilities but one storage boundary: an App cannot spell another App's path, and it cannot open another App's database through a different name.

The same filesystem contract also supports versioned App releases. Source is compiled off-device into Bundles and assets; the board activates a complete release rather than compiling TSX or mutating firmware. That keeps build complexity off the ESP32 while preserving a path to atomic installation and rollback later.

### DB: make the durable path the efficient path

PocketJS DB gives the Bundle SQLite without giving it unrestricted storage. The App owns its schema, transactions and queries. The Host owns the physical mount and limits.

The architecture aligns with the board's performance constraints. Data Actions group product changes into one transaction rather than many small flash writes. Views query bounded projections rather than raw provider payloads or unbounded history. Normal frames read memory, not SQLite. Background Apps do no View work. Only the selected, dirty PocketJS View produces a new DrawList for the display.

This is an important property of the design: the correct data flow is also the cheap one. We did not add a separate ESP-only fast path that bypasses App state. Doing so would make the simulator and hardware run different products. Instead, the portable contract itself requires bounded networking, App-scoped storage, transactional writes and bounded View projections.

### One App contract, different hosts

The macOS ESP32-P4 simulator and the physical board now run the same embedded AgentOS, App descriptors, Data Actions, SQLite schemas and PocketJS Views. They do not run the same host binary. The simulator maps contracts to macOS windows, input, files and HTTP; the board maps them to MIPI-DSI, touch, LittleFS, ESP networking and hardware rendering.

That is the practical meaning of transportability. A Host publishes the capabilities and resource profile it supports. An App that fits those requirements can reuse its product source without board-specific native logic. Target-specific build artifacts remain possible and honest; the ownership boundary stays the same.

The physical ESP32-P4 run closed the important architectural loops: the resident Agent used App Tools, Exa completed search and fetch through PocketJS networking, Robinhood completed its read-only refresh through native MCP, and both Apps persisted the state their Views consume. The point of that evidence is not the individual providers. It is that two very different transports fit the same App model without returning their product logic to firmware.

## Where this goes

The current version is intentionally a fixed built-in catalog. Pocket Pi seeds known App releases at boot and loads the three current Views. That is enough to prove the runtime boundary; it is not yet a Marketplace.

A real Marketplace is the next architectural extension. It needs signed release manifests, artifact hashes, declared capabilities, staging, atomic activation, App-owned schema migrations, rollback and a recovery path. Installing or removing an App must rebuild the Tool Catalog without exposing credentials or letting a partial Bundle become active. Once the catalog grows beyond a few built-ins, measured startup and memory costs can drive lazy loading, pinning or another residency policy.

More hardware follows the same logic. A new device implements PocketJS modules and Pocket Pi Host contracts for its display, input, storage, network and resource limits. Apps remain Tools, Data Actions, SQLite state and a fixed View. A larger screen may use another View artifact; a smaller memory budget may load fewer Guests; neither change should move product semantics into the board adapter.

The first Pocket Pi put an Agent on an ESP32-P4. This architecture takes the next step: it gives the Agent a local software environment that can expand without expanding firmware, gives humans stable Views over the same state the Agent changes, and gives each App a boundary that can survive a new release, a new View and eventually a new piece of hardware.

The central idea is not that the Agent can operate the interface. It is that the Agent and the interface operate the same durable product.
