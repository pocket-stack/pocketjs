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

They are real now ([**Pocket Pi PR #11**](https://github.com/pocket-stack/pocket-pi/pull/11)). We did not want more features just simply welded into firmware. We wanted a definition of App that made sense to an Agent, to a human and to a 32 MB board at the same time.

This post is about that architecture: what the first Pocket Pi still got wrong, what we mean by an agent-native runtime, why the data layer became the center of the system, and how PocketJS makes the result portable without hiding the constraints of the ESP32-P4.

## What Pocket Pi was

The [previous post](/blog/pocket-pi-on-esp32-p4/) covers the original port in detail. QuickJS ran the embedded `pi-agent-core` bundle, while native Rust supplied the workspace, schedules, model transport, device capabilities and product UI. That was the right architecture for proving that the complete Agent really lived on the board.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-esp32-hero.png" alt="The original Pocket Pi device UI, implemented as a native Rust product surface, showing Agent chat, schedules, the LittleFS workspace browser and a file reader." />

It was also still heavy on Rust firmware. The Agent loop was TypeScript, but Rust owned the screen state, file browser, schedules and composition of product capabilities. The boundary was roughly “Agent in JavaScript, product in firmware.” That kept the proof small, but it meant each complete new product would add its Tools, state and View back into firmware. The Agent was portable; the products around it were not yet portable Apps.

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
3. **The Agent is itself a native App and the first-class coordinator of every other App.** As the resident System App, Pi Agent owns `/workspace` and the cross-App Tool Catalog. This gives it system-level access to every App's public Tools and the authority to manage App data through those contracts, while private storage and implementation remain isolated.

Together, these concepts define the Agent/App relationship. An App exposes meaningful operations rather than UI controls. Pi Agent can combine those operations across products and manage App data through public contracts, not by reaching into private SQLite tables. Its System App status gives it the wider ownership and persistent lifecycle required to orchestrate everything else.

Finally, agent-native Apps must be expandable and transportable. Expandable means a new product can bring its Tools, Data Actions, schema and View without adding that product's meaning to firmware. Transportable means the same App source can run anywhere the required PocketJS and AgentOS capabilities exist. It does not mean one byte-identical binary on every board: assets, viewport and ABI can still produce target-specific artifacts. The contract is portable; the hardware remains real.

## The new Pocket Pi architecture

The new runtime has four layers. They are the implementation consequence of the three core concepts: Apps own product meaning, state connects capability to View, and the resident Agent coordinates Apps through their public contracts.

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

The **native Host** owns hardware, secrets and resource policy. **PocketJS** supplies portable QuickJS, UI, NET, FS and DB contracts. **Pocket Pi AgentOS** adds App ownership, lifecycle, Tool routing and scheduling. **App bundles** own the product itself: capabilities, data behavior and View. The current bundle shape makes that boundary concrete:

| Artifact | Architectural role |
| --- | --- |
| `agent-app.json` | identity, Public Tool schemas, Tasks, Schedules and required capabilities |
| `data-action.js` | private Data Actions, provider mapping, normalization and SQLite writes |
| `app.js` + `app.pak` | the fixed PocketJS View and its assets |
| `<app>.sqlite` | durable App-owned product state |

“Fixed View” means fixed for one App release, not hardcoded in firmware. It can evolve with the bundle. It is fixed in the other direction: the Agent does not invent it on every turn, and Data Actions cannot bypass the data layer to push arbitrary presentation into it. That gives the human a stable interface and gives the App author a bounded target to design and test.

### App data is the boundary

This is the most important part of the architecture because it makes all three core concepts enforceable. Data must be separated in two directions: **an App's Data from its View**, and **one App's Data from every other App**.

#### Separating Data from View

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

#### Separating one App's Data from another

The second separation is enforced below SQLite through PocketJS FS. Every ordinary App receives a filesystem mount rooted at its own data directory. Its SQLite database is physically a file inside that mount, so database isolation is part of the same filesystem capability: the App has no path that names another App's files or database.

Pi Agent is the deliberate exception. As the first-class System App, it owns `/workspace` and manages other Apps through their declared Tools and data operations. It does not need to bypass their private schemas. This preserves both halves of core concept three: the Agent has system-wide authority, while each App remains the owner of how its data is represented and changed.

Encoding this boundary in the PocketJS FS mount matters for transportability. An App should not stay isolated because its code remembers an ESP-specific directory convention. It should stay isolated because every compatible Host mounts the same capability-scoped filesystem contract, whether the physical storage is LittleFS on the board or a directory in the simulator.

The macOS simulator makes the ownership boundary visible using the same Files View and AgentOS layout as the board. At the root, Pi Agent can see its own system state, data and the `apps/` boundary. Inside an ordinary App, the active release and private `data/` directory are siblings: code can change as a versioned release while App-owned state survives independently. The same App state then supports a stable human View.

<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 10px; overflow: hidden; border: 1px solid #d8d5cf; border-radius: 14px; background: #f4f1eb">
  <img src="/assets/blog/pocket-pi-agentos-files.png" style="display: block; width: 100%; margin: 0; border-radius: 6px" alt="Pocket Pi Files View at /workspace, showing Pi Agent-owned system state, data and the ordinary apps boundary." />
  <img src="/assets/blog/pocket-pi-agentos-exa-files.png" style="display: block; width: 100%; margin: 0; border-radius: 6px" alt="Pocket Pi Files View inside /workspace/apps/exa, showing its private data and versioned releases." />
  <img src="/assets/blog/pocket-pi-agentos-exa.png" style="display: block; width: 100%; margin: 0; border-radius: 6px" alt="The Exa Research Pocket App projecting its local SQLite-backed search history." />
  <img src="/assets/blog/pocket-pi-agentos-robinhood.png" style="display: block; width: 100%; margin: 0; border-radius: 6px" alt="The Robinhood Pocket App projecting its normalized portfolio state." />
</div>

The state boundary is what makes background autonomy possible without making the model the operating system for every task. A five-minute App refresh can run locally, commit state and update the next View without waking the Agent. The Agent remains responsible for judgment and cross-App composition; deterministic product maintenance stays inside the App.

### Agent as a resident System App

Pi Agent's loop and Root View run in the same PocketJS Guest. `AppSupervisor` creates this System App once and keeps it resident; opening an ordinary App changes only the foreground View. This follows directly from core concept three: conversation, context, workspace and cross-App work must outlive whichever screen is visible.

Pi Agent still participates in the same App release model, so its behavior and View can evolve as code rather than firmware. It is first-class at the system level because its lifetime, `/workspace` mount and Tool Catalog scope are wider than those of ordinary Apps.

The Root View exposes that relationship directly: Apps remain isolated product units, while Pi Agent can discover and use each App's public Tools.

### Apps as portable product units

An ordinary App brings a descriptor, Data Actions, schema, View and assets. AgentOS admits its capabilities and manages its lifecycle; the Host does not acquire a product-specific screen or response parser. That is core concept one turned into a release boundary.

The same boundary makes the App transportable. A new host implements PocketJS modules and AgentOS contracts once; compatible Apps reuse their product source and state model, even when viewport- or ABI-specific artifacts differ.

Exa and Robinhood are two examples of the same contract producing very different products. Each View is stable and human-readable, but neither owns the truth it displays: Exa projects local research history from its SQLite state, while Robinhood projects normalized portfolio state maintained by its Data Actions and Schedule.

## Optimizing the experience on ESP32

Moving product code out of Rust matters only if the new boundary fits the board. PocketJS modules make the core concepts practical without hiding ESP32 resource policy:

| PocketJS module | App owns | Host owns | Why it matters |
| --- | --- | --- | --- |
| NET | `fetch()` calls, request shape and domain decoding | TLS, credentials, endpoint policy and limits | Product networking stays portable without exposing secrets |
| FS | files relative to the App root | the physical mount, quota and release storage | App data isolation is enforced below App code |
| DB | schema, transactions and bounded projections | SQLite storage binding and limits | durable state remains the only bridge to the View |
| UI | the View and its data bindings | DrawList rendering, display and input | product presentation leaves firmware |

The architecture is also the optimization. App source is compiled off-device. Data Actions batch product changes into transactions. Background Apps perform no View work, normal frames read memory rather than SQLite, and only a selected dirty View produces a new DrawList. There is no ESP-only product path that bypasses the state model.

The simulator and physical ESP32-P4 therefore run the same AgentOS contracts, App Data Actions, schemas and Views over different Host adapters. Exa and Robinhood use different transports, but both fit the same App model and persist the state their Views consume. That is the evidence we care about: the architecture survives the board without moving product meaning back into firmware.

## Where this goes

Today, a fixed View is still a compiled PocketJS bundle. The more interesting next step is to make a View a composition of bounded, prebuilt pieces: cards, lists, charts, navigation, actions and typed bindings to an App's data projections.

An App could then ship a small declarative View graph instead of requiring every layout change to compile new JavaScript. The on-device Agent could rearrange components, change bindings or assemble a new View from approved building blocks, while the runtime validates viewport rules, data access and resource budgets. The Agent would be changing presentation directly on the board without compiling TSX or gaining arbitrary native access.

Data/View separation is what makes that safe and useful. The Agent can rebuild how App state is shown without rewriting the Data Actions that produce it, changing private tables or creating another source of truth. Current fixed Views and future composable Views remain two projections over the same durable App-owned data.

A Marketplace would then distribute verified App releases and, eventually, reusable View components; signatures, capabilities, atomic activation and rollback remain necessary, but they are supporting infrastructure rather than the main idea. More hardware follows the same contract: each device supplies PocketJS and AgentOS capabilities, while Apps keep their Tools, data model and View composition.

The first Pocket Pi put an Agent on an ESP32-P4. This architecture gives that Agent a local software environment it can coordinate today—and, with composable Views, reshape directly tomorrow.
