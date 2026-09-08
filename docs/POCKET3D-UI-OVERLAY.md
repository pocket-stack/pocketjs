# PocketJS UI over Pocket3D

`pocket-ui-wgpu::UiOverlay` mounts a compiled PocketJS JS/pak pair in a QuickJS
guest and draws it over the scene through `Game::overlay`. The UI uses the
existing native core, layout, font atlases, hit testing, focus and `onPress`.
Game rules stay with the application.

**The application declares cursor ownership.** `Game::cursor_mode` returns
`Visible` while a control window is open and `Captured` for mouse look.
`Legacy` preserves `AppConfig` and the Escape/click behavior of existing games.
A change clears held keys, buttons and mouse deltas before fixed ticks consume
input. Visible UI clicks cannot recapture the cursor. Focus loss releases capture
and sends cancellation; returning focus does not invent a press.

`Game::resized` receives physical pixels and OS scale before input at the new
viewport. Pass them to `UiOverlay::resize`; layout uses logical pixels and both
pointer coordinates and draw output use the same scale. Raster density belongs
to the pak and can differ from the current display scale.

**Pointer edges retain their order within a rendered frame.** `Input` records
movement, button edges and cancellation. `UiOverlay::frame` forwards them over
the in-process `pocket.overlay` service alongside application JSON state. The
host declares that exact service before mounting the guest; other services stay
denied. Each frame returns the JSON commands sent by the UI.

The UI connects with `connectOverlay<State, Command>` from
`@pocketjs/framework/overlay-host`. Its receiver updates application signals;
`send(command)` queues an intent for the native game. `control(name, node)`
registers a semantic diagnostic name and returns a disposer. `drag(node, move)`
captures a caption or another drag region, reports its start and deltas, and
returns a disposer. Focusable children own their click before ancestor drags.
A release activates only the original, still-hit control. Cancellation,
removal, release outside, and a drag ending over a button cannot activate it.

`UiOverlay::control_bounds` asks the native core for the named control's painted
screen bounds. Acceptance drivers use those bounds to inject cursor/button
edges into the same input path as a native window. The query uses the core's
inspection pass and clears its highlight afterward; it is a cold diagnostic
operation, not a second hit-test layout.

The `XP_THEME` export from `@pocketjs/framework/themes/desktop` supplies complete
class literals for windows, captions, close controls, tabs, buttons, disabled
states, group boxes, wells, status strips, progress bars and checks. Product code
names semantic parts and supplies behavior. The theme uses authored geometric
chrome and the bundled fonts, with no dependency on desktop-shell assets.

Applications can embed the built JS/pak so launching the game requires no JS
build tools. Keep source and artifact hashes beside those files and verify them
when publishing a new build. A pointer-capable game should block its movement
and action handlers while the overlay owns input; simulation can continue so
users can observe reactions behind the controls.
