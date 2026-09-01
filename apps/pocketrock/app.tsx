import { For, Show, createMemo, createSignal } from "solid-js";
import { animate, jump } from "@pocketjs/framework/animation";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { createScroller } from "@pocketjs/framework/kinetics";
import { appTable, launchNativePlugin, launchPackage } from "@pocketjs/framework/launcher";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";
import {
  library,
  playback,
  queue,
  system,
  type LibraryKind,
  type PlaybackSnapshot,
  type SystemSnapshot,
} from "@pocketjs/framework/rockbox";
import AppsPage, { type AppsPageEntry } from "./pages/apps-page.tsx";
import { DisplaySettingsPage, DEFAULT_DISPLAY_SETTINGS } from "./pages/display-settings-page.tsx";
import { EqPage, DEFAULT_EQ_BANDS, DEFAULT_EQ_PRESETS, type EqBand } from "./pages/eq-page.tsx";
import FilesPage from "./pages/files-page.tsx";
import {
  PocketRockHomePage,
  PocketRockSettingsPage,
  POCKETROCK_HOME_DESTINATIONS,
  POCKETROCK_SETTINGS_DESTINATIONS,
} from "./pages/home-settings-pages.tsx";
import LibraryPage from "./pages/library-page.tsx";
import NowPlayingPage from "./pages/now-playing-page.tsx";
import PlaybackSettingsPage, { DEFAULT_PLAYBACK_SETTINGS } from "./pages/playback-settings-page.tsx";
import QueuePage from "./pages/queue-page.tsx";
import SoundSettingsPage, { type SoundSettingsModel } from "./pages/sound-settings-page.tsx";
import { PowerPage, StoragePage, SystemInformationPage } from "./pages/system-pages.tsx";
import UsbPage from "./pages/usb-page.tsx";
import {
  CONTACT_LIST_HEIGHT,
  CONTACT_ROW_HEIGHT,
  CONTACT_SPRING_DAMPING,
  CONTACT_SPRING_OVERSHOOT,
  CONTACT_SPRING_STIFFNESS,
  contactSelectionY,
  contactScrollTarget,
  contactVisibleIndex,
  wheelMultiplier,
} from "../../framework/src/ipod-list-motion.ts";

type Page = "Home" | "Now Playing" | "Music" | "Queue" | "Files" |
  "Apps" | "Settings" | "Library" | "Sound" | "Equalizer" | "Playback" |
  "Display" | "Power" | "Storage" | "System Information";

interface Row {
  title: string;
  subtitle?: string;
  action?: () => void;
}

interface Route {
  page: Page;
  selected: number;
  offset: number;
  libraryKind?: LibraryKind;
  libraryRows?: Row[];
}

interface ScreenSnapshot {
  page: Page;
  title: string;
  rows: Row[];
  selected: number;
  offset: number;
  back: boolean;
  now: PlaybackSnapshot | null;
  notice: string;
}

const MUSIC: readonly LibraryKind[] = ["artists", "albums", "tracks", "playlists"];
const LIST_WINDOW_ROWS = Math.ceil(CONTACT_LIST_HEIGHT / CONTACT_ROW_HEIGHT) + 2;
const WHEEL_IDLE_FRAMES = 6;
const TRANSITION_FRAMES = 8;
const TRANSITION_MS = 110;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function TopBar(props: { title: string; back: boolean }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={!props.back}>
        <Text class="text-base text-white font-bold">{props.title}</Text>
      </Show>
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
        <Text class="text-base text-white font-bold">{props.title}</Text>
      </Show>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function ListSurface(props: { rows: Row[]; selected: number; offset: number }) {
  const first = createMemo(() => Math.max(
    0,
    Math.min(
      Math.max(0, props.rows.length - LIST_WINDOW_ROWS),
      Math.floor(props.offset / CONTACT_ROW_HEIGHT) - 1,
    ),
  ));
  const visible = createMemo(() => props.rows.slice(first(), first() + LIST_WINDOW_ROWS));
  const translateY = createMemo(() => first() * CONTACT_ROW_HEIGHT - props.offset);

  return (
    <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
        <For each={visible()}>{(_, index) => {
          const rowIndex = () => first() + index();
          return (
            <View class="relative w-[320] h-[30]">
              <Show when={
                rowIndex() + 1 < props.rows.length &&
                rowIndex() !== props.selected &&
                rowIndex() + 1 !== props.selected
              }>
                <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
              </Show>
            </View>
          );
        }}</For>
      </View>

      <Show when={props.rows.length > 0}>
        <View
          class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]"
          style={{ translateY: contactSelectionY(props.selected, props.offset) }}
        />
      </Show>

      <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
        <For each={visible()}>{(row) =>
          <View class="relative w-[320] h-[30] flex-col justify-center pl-[12] pr-[9]">
            <Text class="text-sm text-[#18202a] font-bold">{row.title}</Text>
            <Show when={row.subtitle}>
              <Text class="absolute right-[9] top-[9] text-xs text-[#687484]">{row.subtitle}</Text>
            </Show>
          </View>
        }</For>
      </View>
    </View>
  );
}

function PageSurface(props: ScreenSnapshot) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <Show when={props.page === "Now Playing"} fallback={
        <ListSurface rows={props.rows} selected={props.selected} offset={props.offset} />
      }>
        <View class="absolute left-0 top-[36] w-[320] h-[204] flex-col items-center pt-[20] bg-[#18212e]">
          <View class="w-[112] h-[112] rounded-[8] bg-gradient-to-b from-[#3a4658] to-[#202938] border border-[#586579]" />
          <Text class="mt-[9] text-base text-white font-bold">{props.now?.title ?? "Nothing Playing"}</Text>
          <Text class="text-xs text-[#aeb9c8]">{props.now?.artist ?? "SELECT a track"}</Text>
        </View>
      </Show>
      <TopBar title={props.title} back={props.back} />
      <Show when={props.notice}>
        <Text class="absolute left-[8] bottom-[5] text-xs text-[#697586]">{props.notice}</Text>
      </Show>
    </View>
  );
}

function Shell() {
  const [stack, setStack] = createSignal<Route[]>([{ page: "Home", selected: 0, offset: 0 }]);
  const [selected, setSelected] = createSignal(0);
  const [notice, setNotice] = createSignal("");
  const [soundModel, setSoundModel] = createSignal<SoundSettingsModel>({
    volume: -1800,
    balance: 0,
    bass: 0,
    treble: 0,
    channelMode: "Stereo",
    crossfeed: false,
  });
  const [eqEnabled, setEqEnabled] = createSignal(false);
  const [eqPreset, setEqPreset] = createSignal<string>(DEFAULT_EQ_PRESETS[0]);
  const [eqBands, setEqBands] = createSignal<EqBand[]>(DEFAULT_EQ_BANDS.map((band) => ({ ...band })));
  const [transitionSnapshot, setTransitionSnapshot] = createSignal<ScreenSnapshot | null>(null);
  let activePanel: NodeMirror | undefined;
  let transitionPanel: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelTargetIndex = 0;
  let wheelIdleFrames = WHEEL_IDLE_FRAMES;
  let transitionFrames = 0;

  const route = createMemo(() => stack()[stack().length - 1]);
  const page = createMemo(() => route().page);
  const serviceActive = () => typeof getOps().pocketrockCall === "function";

  const safePlayback = (): PlaybackSnapshot | null => {
    if (!serviceActive()) return null;
    try { return playback.snapshot(); } catch { return null; }
  };

  const safeSystem = (): SystemSnapshot | null => {
    if (!serviceActive()) return null;
    try { return system.snapshot(); } catch { return null; }
  };

  const allApps = (): AppsPageEntry[] => (appTable()?.apps ?? []).map((app) => ({
    title: app.title,
    id: app.id,
    kind: app.kind ?? "pocket",
    path: app.path,
    builtIn: app.id?.startsWith("dev.pocket-stack."),
    valid: app.kind === "rockbox" ? Boolean(app.path) : Boolean(app.id),
  }));

  const rows = createMemo<Row[]>(() => {
    switch (page()) {
    case "Home": return POCKETROCK_HOME_DESTINATIONS.map((title) => ({ title, action: () => push({ page: title }) }));
    case "Music": return MUSIC.map((kind) => ({ title: titleCase(kind), action: () => openLibrary(kind) }));
    case "Library": return route().libraryRows ?? [];
    case "Queue": {
      if (!serviceActive()) return [{ title: "Queue unavailable", subtitle: "Host ABI 10 required" }];
      try {
        return queue.page(0, 64).items.map((item) => ({
          title: item.title || item.path,
          subtitle: item.artist,
          action: () => queue.play(item.index),
        }));
      } catch (error) { return [{ title: "Queue unavailable", subtitle: String(error) }]; }
    }
    case "Apps": return allApps().map((app) => ({
      title: app.title ?? "Untitled package",
      subtitle: app.path ?? app.id,
      action: () => app.kind === "rockbox" && app.path
        ? launchNativePlugin(app.path)
        : app.id ? launchPackage(app.id) : undefined,
    }));
    case "Settings": return POCKETROCK_SETTINGS_DESTINATIONS.map((title) => ({
      title,
      action: () => push({ page: title }),
    }));
    case "Sound": return ["Volume", "Balance", "Bass", "Treble", "Channel Mode", "Crossfeed", "Equalizer"].map((title) => ({
      title,
      action: title === "Equalizer" ? () => push({ page: "Equalizer" }) : undefined,
    }));
    case "Equalizer": return ["Enabled", "Preset", ...eqBands().map((band) => band.frequency)].map((title) => ({ title }));
    case "Playback": return DEFAULT_PLAYBACK_SETTINGS.map((row) => ({ title: row.label, subtitle: row.value }));
    case "Display": return DEFAULT_DISPLAY_SETTINGS.map((row) => ({ title: row.label }));
    case "Power": return [
      { title: "Sleep" },
      { title: "Power off", action: () => { if (serviceActive()) system.powerOff(); } },
      { title: "Restart", action: () => { if (serviceActive()) system.reboot(); } },
    ];
    case "Files": return [{ title: "/", subtitle: "Full-volume browser" }, { title: ".rockbox" }, { title: "Music" }];
    default: return [];
    }
  });

  const maxOffset = () => Math.max(0, rows().length * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT);
  const listScroller = createScroller({ max: maxOffset, extent: () => CONTACT_LIST_HEIGHT });
  const title = () => page() === "Library"
    ? titleCase(route().libraryKind ?? "artists")
    : page();

  const activeSnapshot = (): ScreenSnapshot => ({
    page: page(),
    title: title(),
    rows: rows(),
    selected: selected(),
    offset: listScroller.offset(),
    back: stack().length > 1,
    now: safePlayback(),
    notice: notice(),
  });
  const saveCurrentRoute = (): Route => ({
    ...route(),
    selected: selected(),
    offset: listScroller.offset(),
  });

  function resetWheel(nextSelected: number): void {
    wheelDirection = 0;
    wheelBurst = 0;
    wheelTargetIndex = nextSelected;
    wheelIdleFrames = WHEEL_IDLE_FRAMES;
  }

  function restoreRoute(next: Route): void {
    listScroller.stop();
    listScroller.scrollTo(next.offset, { immediate: true });
    setSelected(next.selected);
    resetWheel(next.selected);
  }

  function beginTransition(snapshot: ScreenSnapshot, direction: "push" | "pop"): void {
    setTransitionSnapshot(snapshot);
    transitionFrames = TRANSITION_FRAMES;
    queueMicrotask(() => {
      if (!activePanel || !transitionPanel) return;
      if (direction === "push") {
        jump(activePanel, "translateX", 320);
        jump(transitionPanel, "translateX", 0);
        animate(transitionPanel, "translateX", -64, { dur: TRANSITION_MS, easing: "out" });
        animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
      } else {
        jump(activePanel, "translateX", -64);
        jump(transitionPanel, "translateX", 0);
        animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
        animate(transitionPanel, "translateX", 320, { dur: TRANSITION_MS, easing: "out" });
      }
    });
  }

  function push(next: Pick<Route, "page"> & Partial<Route>): void {
    if (transitionFrames > 0) return;
    const snapshot = activeSnapshot();
    const current = saveCurrentRoute();
    const destination: Route = {
      page: next.page,
      selected: next.selected ?? 0,
      offset: next.offset ?? 0,
      libraryKind: next.libraryKind,
      libraryRows: next.libraryRows,
    };
    setStack((value) => [...value.slice(0, -1), current, destination]);
    restoreRoute(destination);
    beginTransition(snapshot, "push");
  }

  function pop(): void {
    if (stack().length <= 1 || transitionFrames > 0) return;
    const snapshot = activeSnapshot();
    const destination = stack()[stack().length - 2];
    setStack((value) => value.slice(0, -1));
    restoreRoute(destination);
    beginTransition(snapshot, "pop");
  }

  function openLibrary(kind: LibraryKind): void {
    let libraryRows: Row[];
    if (!serviceActive()) {
      libraryRows = [{ title: "Library unavailable", subtitle: "Tagcache service is offline" }];
    } else {
      try {
        const result = library.page(kind, 0, 64);
        libraryRows = result.items.map((item) => ({ title: item.title, subtitle: item.subtitle }));
        if (result.scanning) setNotice("Tagcache scanning");
      } catch (error) {
        libraryRows = [{ title: "Library unavailable", subtitle: String(error) }];
      }
    }
    push({ page: "Library", libraryKind: kind, libraryRows });
  }

  function moveSelection(delta: number): void {
    const count = rows().length;
    if (count === 0) return;
    const nextTarget = Math.max(0, Math.min(count - 1, wheelTargetIndex + delta));
    if (nextTarget === wheelTargetIndex) return;
    wheelTargetIndex = nextTarget;
    setSelected(contactVisibleIndex(nextTarget, listScroller.offset(), count));
    const target = contactScrollTarget(nextTarget, listScroller.intent(), maxOffset());
    if (target !== null) {
      listScroller.springTo(target, {
        overshootPx: CONTACT_SPRING_OVERSHOOT,
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  }

  function updateVisualSelection(): void {
    if (rows().length === 0) return;
    setSelected(contactVisibleIndex(wheelTargetIndex, listScroller.offset(), rows().length));
  }

  function settleReleasedSelection(): void {
    if (rows().length === 0) return;
    const nextSelected = contactVisibleIndex(wheelTargetIndex, listScroller.offset(), rows().length);
    wheelTargetIndex = nextSelected;
    setSelected(nextSelected);
    const target = contactScrollTarget(nextSelected, listScroller.offset(), maxOffset());
    listScroller.stop();
    if (target !== null) {
      listScroller.springTo(target, {
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  }

  function acceleratedWheelDelta(direction: -1 | 1): number {
    if (wheelDirection !== direction || wheelIdleFrames >= WHEEL_IDLE_FRAMES) {
      wheelDirection = direction;
      wheelBurst = 0;
      wheelTargetIndex = selected();
    } else {
      wheelBurst += 1;
    }
    wheelIdleFrames = 0;
    return direction * wheelMultiplier(wheelBurst);
  }

  function cycleEqPreset(direction: -1 | 1): void {
    const presets = DEFAULT_EQ_PRESETS;
    const current = Math.max(0, presets.indexOf(eqPreset() as typeof presets[number]));
    setEqPreset(presets[(current + direction + presets.length) % presets.length]);
  }

  function adjustCurrent(direction: -1 | 1): void {
    if (page() === "Now Playing") {
      if (serviceActive()) direction < 0 ? playback.previous() : playback.next();
      return;
    }
    if (page() === "Sound") {
      const index = selected();
      setSoundModel((value) => {
        if (index === 0) return { ...value, volume: Math.max(-7400, Math.min(0, value.volume + direction * 100)) };
        if (index === 1) return { ...value, balance: Math.max(-100, Math.min(100, value.balance + direction * 5)) };
        if (index === 2) return { ...value, bass: Math.max(-24, Math.min(24, value.bass + direction)) };
        if (index === 3) return { ...value, treble: Math.max(-24, Math.min(24, value.treble + direction)) };
        if (index === 4) {
          const modes: SoundSettingsModel["channelMode"][] = ["Stereo", "Mono", "Custom"];
          const current = modes.indexOf(value.channelMode);
          return { ...value, channelMode: modes[(current + direction + modes.length) % modes.length] };
        }
        if (index === 5) return { ...value, crossfeed: !value.crossfeed };
        return value;
      });
      return;
    }
    if (page() === "Equalizer") {
      const index = selected();
      if (index === 0) setEqEnabled((value) => !value);
      else if (index === 1) cycleEqPreset(direction);
      else setEqBands((bands) => bands.map((band, bandIndex) => bandIndex === index - 2
        ? { ...band, gain: Math.max(-12, Math.min(12, band.gain + direction)) }
        : band));
      return;
    }
    if (page() === "Playback" && serviceActive()) {
      const now = safePlayback();
      if (selected() === 0) {
        const values = ["off", "all", "one"];
        const current = Math.max(0, values.indexOf(now?.repeat ?? "off"));
        playback.setRepeat(values[(current + direction + values.length) % values.length]);
      } else if (selected() === 1) playback.setShuffle(!(now?.shuffle ?? false));
    }
  }

  function CurrentPage() {
    const now = safePlayback();
    const device = safeSystem();
    if (device && device.usb !== "disconnected") {
      return <UsbPage connected mode={device.usb === "mass-storage" ? "mass-storage" : "charging"} />;
    }
    if (page() === "Home") {
      return <PocketRockHomePage
        selected={selected()}
        nowPlaying={now ? { title: now.title, artist: now.artist, album: now.album, playing: now.status === "playing" } : null}
        subtitles={{
          Music: "Artists · Albums · Tracks",
          Queue: "Current playlist",
          Files: "iPod storage",
          Apps: `${allApps().length} installed`,
          Settings: "Sound · Display · System",
        }}
      />;
    }
    if (page() === "Now Playing") {
      const rawVolume = now?.volume ?? -74;
      const volume = Math.max(0, Math.min(100, Math.round((rawVolume + 74) * 100 / 74)));
      const repeat = now?.repeat === "one" ? "one" : now?.repeat === "off" ? "off" : "all";
      return <NowPlayingPage
        title={now?.title || "Nothing Playing"}
        artist={now?.artist || "Select a track"}
        album={now?.album}
        positionSeconds={(now?.elapsedMs ?? 0) / 1000}
        durationSeconds={(now?.durationMs ?? 0) / 1000}
        playing={now?.status === "playing"}
        volume={volume}
        shuffle={now?.shuffle ?? false}
        repeat={repeat}
        back
      />;
    }
    if (page() === "Music") {
      return <LibraryPage view="categories" selected={selected()} offset={listScroller.offset()} back />;
    }
    if (page() === "Library") {
      return <LibraryPage
        view="results"
        kind={route().libraryKind}
        items={(route().libraryRows ?? []).map((row, id) => ({ id, title: row.title, subtitle: row.subtitle }))}
        selected={selected()}
        offset={listScroller.offset()}
        state={notice() === "Tagcache scanning" ? "scanning" : "ready"}
        back
      />;
    }
    if (page() === "Queue") {
      const items = rows().map((row, index) => ({ index, title: row.title, artist: row.subtitle }));
      return <QueuePage items={items} selected={selected()} offset={listScroller.offset()} playingIndex={now?.index} back />;
    }
    if (page() === "Files") {
      return <FilesPage
        path="/"
        showParent={false}
        selected={selected()}
        offset={listScroller.offset()}
        usbState="normal"
        entries={[
          { id: ".rockbox", name: ".rockbox", kind: "directory", subtitle: "Rockbox system" },
          { id: "Music", name: "Music", kind: "directory", subtitle: "Audio files" },
          { id: "Playlists", name: "Playlists", kind: "directory", subtitle: "Saved queues" },
        ]}
      />;
    }
    if (page() === "Apps") {
      return <AppsPage apps={allApps()} selected={selected()} offset={listScroller.offset()} appTableAvailable={appTable() !== null} />;
    }
    if (page() === "Settings") {
      return <PocketRockSettingsPage selected={selected()} values={{
        Sound: now ? `${now.volume} dB` : "Audio",
        Playback: now?.shuffle ? "Shuffle on" : "Repeat / Resume",
        Display: device?.backlight ? "Backlight on" : "Backlight off",
        Power: device ? `${device.batteryPercent}%` : "Battery",
        Storage: device ? `${Math.floor(device.freeBytes / 1048576)} MiB free` : "Storage",
        "System Information": "PocketRock 0.1",
      }} />;
    }
    if (page() === "Sound") return <SoundSettingsPage model={soundModel()} selected={selected()} adjusting />;
    if (page() === "Equalizer") return <EqPage
      enabled={eqEnabled()}
      preset={eqPreset()}
      bands={eqBands()}
      selectedControl={selected() === 0 ? "enabled" : selected() === 1 ? "preset" : "bands"}
      selectedBand={Math.max(0, selected() - 2)}
      adjusting={selected() >= 2}
    />;
    if (page() === "Playback") {
      const settings = DEFAULT_PLAYBACK_SETTINGS.map((row, index) => index === 0
        ? { ...row, value: now?.repeat ?? row.value }
        : index === 1 ? { ...row, value: now?.shuffle ? "On" : "Off" } : row);
      return <PlaybackSettingsPage rows={settings} selected={selected()} offset={listScroller.offset()} back />;
    }
    if (page() === "Display") return <DisplaySettingsPage rows={DEFAULT_DISPLAY_SETTINGS} selected={selected()} offset={listScroller.offset()} back />;
    if (page() === "Power") return <PowerPage snapshot={device ?? undefined} selectedAction={selected()} onPowerOff={() => serviceActive() && system.powerOff()} onReboot={() => serviceActive() && system.reboot()} onBack={pop} />;
    if (page() === "Storage") return <StoragePage snapshot={device ?? undefined} onBack={pop} />;
    if (page() === "System Information") return <SystemInformationPage info={{
      pocketRockVersion: "0.1.0",
      rockboxVersion: "PocketRock",
      quickJsVersion: "2025-09-13",
      abiVersion: 10,
      deviceModel: "iPod Classic 6/7G",
      deviceName: "PocketRock",
    }} onBack={pop} />;
    return <PageSurface {...activeSnapshot()} />;
  }

  onFrame((buttons) => {
    if (transitionFrames > 0) {
      transitionFrames -= 1;
      if (transitionFrames === 0) {
        setTransitionSnapshot(null);
        if (activePanel) jump(activePanel, "translateX", 0);
      }
      return;
    }
    listScroller.step();
    updateVisualSelection();
    if ((buttons & BTN.UP) !== 0) moveSelection(acceleratedWheelDelta(-1));
    else if ((buttons & BTN.DOWN) !== 0) moveSelection(acceleratedWheelDelta(1));
    else {
      wheelIdleFrames = Math.min(WHEEL_IDLE_FRAMES, wheelIdleFrames + 1);
      if (wheelDirection !== 0 && wheelIdleFrames === 1) settleReleasedSelection();
      if (wheelDirection !== 0 && wheelIdleFrames === WHEEL_IDLE_FRAMES) resetWheel(selected());
    }
  });

  onButtonPress(BTN.CIRCLE, () => {
    if (transitionFrames !== 0) return;
    if (page() === "Equalizer" && selected() < 2) adjustCurrent(1);
    else rows()[selected()]?.action?.();
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, pop, { latched: true });
  onButtonPress(BTN.START, () => { if (serviceActive()) playback.toggle(); }, { latched: true });
  onButtonPress(BTN.LEFT, () => adjustCurrent(-1), { latched: true });
  onButtonPress(BTN.RIGHT, () => adjustCurrent(1), { latched: true });

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View ref={(node) => (activePanel = node)} class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden">
        <Show when={page()} keyed>{(_currentPage) => <CurrentPage />}</Show>
      </View>
      <Show when={transitionSnapshot()} keyed>{(snapshot) =>
        <View ref={(node) => (transitionPanel = node)} class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden">
          <PageSurface {...snapshot} />
        </View>
      }</Show>
    </View>
  );
}

mount(() => <Shell />);
