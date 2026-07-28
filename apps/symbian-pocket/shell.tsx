import { For, Show, createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

import { command, pollEvents, sensorSnapshot, type DeviceEvent, type SensorSnapshot } from "./device.ts";
import {
  APP_CATALOG,
  KEYPAD,
  appendKey,
  calculate,
  moveGrid,
  moveSnake,
  nextLanguage,
  shouldPersistWifi,
  type AppDescriptor,
  type Direction,
  type Language,
  type SnakeState,
} from "./model.ts";

type Screen =
  | "home"
  | "contacts"
  | "messages"
  | "calendar"
  | "alarms"
  | "notes"
  | "calculator"
  | "files"
  | "gallery"
  | "music"
  | "snake"
  | "connectivity"
  | "wifi"
  | "wifiPassword"
  | "wifiSave"
  | "bluetooth"
  | "sensors"
  | "hardware"
  | "settings"
  | "quick";

interface WifiItem {
  ssid: string;
  rssi: number;
  channel: number;
  secure: boolean;
}

interface RadioItem {
  name: string;
  address: string;
  rssi: number;
  kind: string;
}

const BLUE_TOP = "#1e73bd";
const BLUE_BOTTOM = "#073a78";
const BLUE_SELECT = "#2c8bd2";
const SILVER = "#e7ecf1";
const INK = "#101820";
const MUTED = "#566675";

const tr = (
  language: Language,
  chinese: string,
  english: string,
): string => language === "zh" ? chinese : english;

const blankSnapshot: SensorSnapshot = sensorSnapshot();

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

function timeText(uptimeMs: number): string {
  const total = Math.floor(uptimeMs / 60000);
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function StatusBar(props: { snapshot: SensorSnapshot }) {
  return (
    <View class="h-[12] flex-row items-center justify-between px-[3] bg-gradient-to-b from-[#1e73bd] to-[#073a78]">
      <Text class="text-xs font-bold text-white">SP</Text>
      <Text class="text-xs text-white">{timeText(props.snapshot.uptimeMs)}</Text>
      <Text class="text-xs text-white">
        {props.snapshot.wifiConnected ? "W" : "-"}
        {props.snapshot.bluetoothReady ? "B" : "-"}
        {props.snapshot.sdMounted ? "S" : "-"}
      </Text>
    </View>
  );
}

function TitleBar(props: { title: string; busy?: boolean }) {
  return (
    <View class="h-[16] flex-row items-center px-[4] bg-gradient-to-b from-[#f8fafc] to-[#cbd5e1] border-[#8fa2b5] overflow-hidden">
      <View class="w-[4] h-[12] bg-[#1e73bd] mr-[3]" />
      <Text class="text-xs font-bold text-[#122235]">{props.title}</Text>
      <Show when={props.busy}>
        <View class="absolute right-[4] w-[30] h-[3] bg-[#9fb4c7] overflow-hidden">
          <View class="w-[20] h-[3] bg-[#2c8bd2] animate-s60-scan" />
        </View>
      </Show>
    </View>
  );
}

function SoftKeys(props: { language: Language; left?: string; center?: string; right?: string }) {
  return (
    <View class="h-[15] flex-row items-center justify-between px-[4] bg-gradient-to-b from-[#dbe4ec] to-[#9baebf] border-[#788c9f]">
      <Text class="text-xs font-bold text-[#12365f]">
        {props.left ?? tr(props.language, "选项", "Options")}
      </Text>
      <Text class="text-xs text-[#36536f]">{props.center ?? "A"}</Text>
      <Text class="text-xs font-bold text-[#12365f]">
        {props.right ?? tr(props.language, "返回", "Back")}
      </Text>
    </View>
  );
}

function Chrome(props: {
  title: string;
  language: Language;
  snapshot: SensorSnapshot;
  busy?: boolean;
  children: JSX.Element;
  left?: string;
  center?: string;
  right?: string;
}) {
  return (
    <View class="w-full h-full flex-col bg-[#e7ecf1] overflow-hidden">
      <StatusBar snapshot={props.snapshot} />
      <TitleBar title={props.title} busy={props.busy} />
      <View class="flex-1 flex-col bg-gradient-to-b from-[#f9fbfd] to-[#d7e2ec] overflow-hidden animate-s60-screen-in">
        {props.children}
      </View>
      <SoftKeys
        language={props.language}
        left={props.left}
        center={props.center}
        right={props.right}
      />
    </View>
  );
}

function HomeGrid(props: {
  language: Language;
  selected: number;
  onPage: readonly AppDescriptor[];
  pageStart: number;
}) {
  return (
    <View class="flex-1 flex-row flex-wrap px-[4] py-[2] bg-gradient-to-b from-[#dfeaf3] to-[#a9c4da]">
      <For each={props.onPage}>
        {(app, localIndex) => {
          const selected = () => props.pageStart + localIndex() === props.selected;
          return (
            <View
              class={selected()
                ? "w-[50] h-[27] flex-row items-center px-[3] rounded-sm bg-gradient-to-b from-[#5bb2ec] to-[#1267ad] border-white animate-s60-cursor"
                : "w-[50] h-[27] flex-row items-center px-[3] rounded-sm bg-[#d5e4ef] border-[#9ab3c6]"}
            >
              <View
                class={selected()
                  ? "w-[17] h-[17] items-center justify-center rounded-sm bg-[#eef8ff] border-[#0c4f8a]"
                  : "w-[17] h-[17] items-center justify-center rounded-sm bg-gradient-to-b from-[#ffffff] to-[#a6bfd1] border-[#607f98]"}
              >
                <Text class={selected() ? "text-xs font-bold text-[#0b4f88]" : "text-xs font-bold text-[#1a4b73]"}>
                  {app.icon}
                </Text>
              </View>
              <View class="flex-1 pl-[2] overflow-hidden">
                <Text class={selected() ? "text-xs font-bold text-white" : "text-xs text-[#122235]"}>
                  {props.language === "zh" ? app.zh : app.en}
                </Text>
              </View>
            </View>
          );
        }}
      </For>
    </View>
  );
}

function ListPage(props: {
  items: readonly string[];
  selected: number;
  empty: string;
  details?: readonly string[];
}) {
  const top = () => Math.max(0, Math.min(props.selected - 2, Math.max(0, props.items.length - 5)));
  const visible = createMemo(() => props.items.slice(top(), top() + 5));
  return (
    <View class="flex-1 flex-col py-[1]">
      <Show when={props.items.length > 0} fallback={
        <View class="flex-1 items-center justify-center px-[8]">
          <Text class="text-xs text-[#566675]">{props.empty}</Text>
        </View>
      }>
        <For each={visible()}>
          {(item, localIndex) => {
            const absoluteIndex = () => top() + localIndex();
            const active = () => absoluteIndex() === props.selected;
            return (
              <View
                class={active()
                  ? "h-[17] flex-row items-center justify-between px-[4] bg-gradient-to-b from-[#5aaee4] to-[#1769aa] border-white"
                  : "h-[17] flex-row items-center justify-between px-[4] bg-[#edf3f7] border-[#c2d0db]"}
              >
                <Text class={active() ? "text-xs font-bold text-white" : "text-xs text-[#101820]"}>
                  {item}
                </Text>
                <Show when={props.details?.[absoluteIndex()]}>
                  <Text class={active() ? "text-xs text-white" : "text-xs text-[#566675]"}>
                    {props.details?.[absoluteIndex()]}
                  </Text>
                </Show>
              </View>
            );
          }}
        </For>
      </Show>
    </View>
  );
}

function InfoRows(props: { rows: readonly [string, string][] }) {
  return (
    <View class="flex-1 flex-col py-[1]">
      <For each={props.rows.slice(0, 6)}>
        {(row, index) => (
          <View class={index() % 2 === 0
            ? "h-[14] flex-row items-center justify-between px-[4] bg-[#edf3f7]"
            : "h-[14] flex-row items-center justify-between px-[4] bg-[#dbe7f0]"}>
            <Text class="text-xs text-[#33485b]">{row[0]}</Text>
            <Text class="text-xs font-bold text-[#102d4b]">{row[1]}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

function Keyboard(props: {
  language: Language;
  row: number;
  col: number;
  text: string;
}) {
  const rows = [...KEYPAD, "^   SPACE   OK"];
  return (
    <View class="flex-1 flex-col px-[2] py-[1]">
      <View class="h-[16] flex-row items-center px-[3] bg-white border-[#7f95a8] overflow-hidden">
        <Text class="text-xs text-[#122235]">
          {props.text ? "*".repeat(Math.min(18, props.text.length)) : tr(props.language, "输入密码", "Password")}
        </Text>
      </View>
      <For each={rows}>
        {(characters, rowIndex) => {
          const special = () => rowIndex() === 5;
          const cells = () => special() ? ["^", "SPACE", "OK"] : characters.split("");
          return (
            <View class="h-[11] flex-row justify-center">
              <For each={cells()}>
                {(character, colIndex) => {
                  const active = () => rowIndex() === props.row && colIndex() === props.col;
                  return (
                    <View class={active()
                      ? special()
                        ? "w-[50] h-[11] items-center justify-center bg-[#1769aa] border-white"
                        : "w-[15] h-[11] items-center justify-center bg-[#1769aa] border-white"
                      : special()
                        ? "w-[50] h-[11] items-center justify-center bg-[#d8e3eb] border-[#8499aa]"
                        : "w-[15] h-[11] items-center justify-center bg-[#edf3f7] border-[#aabac7]"}>
                      <Text class={active() ? "text-xs font-bold text-white" : "text-xs text-[#102d4b]"}>
                        {character}
                      </Text>
                    </View>
                  );
                }}
              </For>
            </View>
          );
        }}
      </For>
    </View>
  );
}

function SnakeBoard(props: { state: SnakeState }) {
  return (
    <View class="flex-1 items-center justify-center bg-[#a8bd79]">
      <View class="relative w-[120] h-[60] bg-[#b9cc8b] border-[#405027] overflow-hidden">
        <For each={props.state.body}>
          {(point, index) => (
            <View
              class={index() === 0
                ? "absolute w-[6] h-[6] bg-[#1e3213] rounded-sm"
                : "absolute w-[6] h-[6] bg-[#405b25] rounded-sm"}
              style={{ insetL: point.x * 6, insetT: point.y * 6 }}
            />
          )}
        </For>
        <View
          class="absolute w-[6] h-[6] bg-[#8b241f] rounded-sm animate-s60-cursor"
          style={{ insetL: props.state.food.x * 6, insetT: props.state.food.y * 6 }}
        />
      </View>
    </View>
  );
}

export default function SymbianPocket() {
  const [language, setLanguage] = createSignal<Language>("zh");
  const [screen, setScreen] = createSignal<Screen>("home");
  const [homeSelected, setHomeSelected] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [toast, setToast] = createSignal("");
  const [snapshot, setSnapshot] = createSignal(blankSnapshot);
  const [wifi, setWifi] = createSignal<WifiItem[]>([]);
  const [radio, setRadio] = createSignal<RadioItem[]>([]);
  const [files, setFiles] = createSignal<string[]>([]);
  const [selectedSsid, setSelectedSsid] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [keyboardRow, setKeyboardRow] = createSignal(0);
  const [keyboardCol, setKeyboardCol] = createSignal(0);
  const [wifiSaveChoice, setWifiSaveChoice] = createSignal(0);
  const [calculatorText, setCalculatorText] = createSignal("");
  const [calcCursor, setCalcCursor] = createSignal(0);
  const [quickCursor, setQuickCursor] = createSignal(0);
  const [contacts, setContacts] = createSignal(["Ada Lovelace", "Alan Turing", "Pocket Device"]);
  const [notes, setNotes] = createSignal(["Welcome to Symbian Pocket", "SD: /SymbianPocket"]);
  const [messages, setMessages] = createSignal(["System: PocketJS ready", "Bluetooth inbox is empty"]);
  const [alarms, setAlarms] = createSignal<string[]>([]);
  const [snake, setSnake] = createSignal<SnakeState>({
    body: [{ x: 8, y: 5 }, { x: 7, y: 5 }, { x: 6, y: 5 }],
    direction: "right",
    food: { x: 14, y: 4 },
    score: 0,
    alive: true,
  });

  const homePageStart = createMemo(() => Math.floor(homeSelected() / 9) * 9);
  const homePage = createMemo(() => APP_CATALOG.slice(homePageStart(), homePageStart() + 9));
  const currentApp = createMemo(() => APP_CATALOG.find((app) => app.id === screen()));

  const title = () => {
    if (screen() === "home") return "Symbian Pocket";
    if (screen() === "wifi") return "Wi-Fi";
    if (screen() === "wifiPassword") return tr(language(), "WLAN 密码", "WLAN password");
    if (screen() === "wifiSave") return tr(language(), "保存连接", "Save connection");
    if (screen() === "bluetooth") return "Bluetooth";
    if (screen() === "quick") return tr(language(), "快捷操作", "Quick actions");
    const app = currentApp();
    return app ? (language() === "zh" ? app.zh : app.en) : "Symbian Pocket";
  };

  const returnHome = () => {
    setScreen("home");
    setCursor(0);
    setBusy(false);
    setToast("");
  };

  const goBack = () => {
    const value = screen();
    if (value === "home") return;
    if (value === "wifi" || value === "bluetooth") {
      setScreen("connectivity");
    } else if (value === "wifiPassword" || value === "wifiSave") {
      setScreen("wifi");
    } else if (value === "quick") {
      setScreen("home");
    } else {
      returnHome();
    }
    setCursor(0);
    setToast("");
  };

  const setDirection = (direction: Direction) => {
    const opposite: Record<Direction, Direction> = {
      up: "down",
      down: "up",
      left: "right",
      right: "left",
    };
    setSnake((state) =>
      state.direction === opposite[direction] ? state : { ...state, direction },
    );
  };

  const moveKeyboard = (direction: Direction) => {
    let row = keyboardRow();
    let col = keyboardCol();
    const columns = row === 5 ? 3 : 10;
    if (direction === "left") col = (col - 1 + columns) % columns;
    else if (direction === "right") col = (col + 1) % columns;
    else if (direction === "up") {
      if (row === 0) {
        row = 5;
        col = col < 4 ? 0 : col < 7 ? 1 : 2;
      } else if (row === 5) {
        row = 4;
        col = [1, 5, 8][col] ?? 1;
      } else row -= 1;
    } else {
      if (row === 4) {
        row = 5;
        col = col < 4 ? 0 : col < 7 ? 1 : 2;
      } else if (row === 5) {
        row = 0;
        col = [1, 5, 8][col] ?? 1;
      } else row += 1;
    }
    setKeyboardRow(row);
    setKeyboardCol(col);
  };

  const listLength = () => {
    switch (screen()) {
      case "contacts": return contacts().length;
      case "messages": return messages().length;
      case "calendar": return 3;
      case "alarms": return alarms().length;
      case "notes": return notes().length;
      case "files":
      case "gallery": return files().length;
      case "music": return 5;
      case "connectivity": return 3;
      case "wifi": return wifi().length;
      case "bluetooth": return radio().length;
      case "hardware": return 7;
      case "settings": return 5;
      default: return 1;
    }
  };

  const moveSelection = (delta: number) => {
    const count = listLength();
    if (count > 0) setCursor((value) => (value + delta + count) % count);
  };

  const scanWifi = () => {
    setWifi([]);
    setCursor(0);
    setBusy(true);
    setToast(tr(language(), "正在搜索 WLAN…", "Searching WLAN…"));
    command("wifi.scan");
  };

  const scanBluetooth = (kind: "ble" | "classic") => {
    setRadio([]);
    setCursor(0);
    setBusy(true);
    setToast(tr(language(), "正在搜索设备…", "Searching devices…"));
    command("radio.scan", { kind });
    setScreen("bluetooth");
  };

  const openSelectedApp = () => {
    const app = APP_CATALOG[homeSelected()];
    if (!app) return;
    setScreen(app.id as Screen);
    setCursor(0);
    setToast("");
    if (app.id === "files" || app.id === "gallery") {
      setBusy(true);
      command("storage.list", { path: app.id === "gallery" ? "/" : "/SymbianPocket" });
    }
  };

  const selectKeyboardKey = () => {
    const row = keyboardRow();
    const col = keyboardCol();
    if (row < 5) {
      setPassword((value) => appendKey(value, KEYPAD[row][col] ?? ""));
      return;
    }
    if (col === 0) {
      setKeyboardRow(0);
      setKeyboardCol(0);
    } else if (col === 1) {
      setPassword((value) => appendKey(value, " "));
    } else {
      setBusy(true);
      setToast(tr(language(), "正在连接…", "Connecting…"));
      command("wifi.connect", { ssid: selectedSsid(), password: password() });
    }
  };

  const activate = () => {
    switch (screen()) {
      case "home":
        openSelectedApp();
        break;
      case "contacts": {
        const contact = `Contact ${contacts().length + 1}`;
        setContacts((value) => [...value, contact]);
        command("storage.append", { path: "/SymbianPocket/contacts.jsonl", text: contact });
        setToast(tr(language(), "已新增名片", "Contact added"));
        break;
      }
      case "messages": {
        const message = `Hello ${messages().length}`;
        setMessages((value) => [...value, `Outbox: ${message}`]);
        command("bluetooth.send", { text: message });
        setToast(tr(language(), "信息已进入发件箱", "Queued in outbox"));
        break;
      }
      case "calendar":
        setToast(tr(language(), "日历视图已更新", "Calendar view refreshed"));
        break;
      case "alarms": {
        const label = tr(language(), `提醒 ${alarms().length + 1}`, `Alarm ${alarms().length + 1}`);
        command("alarm.add", { afterMinutes: 5, label });
        setAlarms((value) => [...value, `+5m  ${label}`]);
        setToast(tr(language(), "已添加 5 分钟闹钟", "5 minute alarm added"));
        break;
      }
      case "notes": {
        const note = `Note ${notes().length + 1}`;
        setNotes((value) => [...value, note]);
        command("storage.append", { path: "/SymbianPocket/notes.txt", text: note });
        setToast(tr(language(), "已保存记事", "Note saved"));
        break;
      }
      case "calculator": {
        const keys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+"];
        const key = keys[calcCursor()];
        if (key === "=") setCalculatorText(calculate(calculatorText()));
        else setCalculatorText((value) => appendKey(value === "ERR" ? "" : value, key, 24));
        break;
      }
      case "music": {
        const tones = [523, 659, 784, 880, 1047];
        command("tone.play", { frequency: tones[cursor()], durationMs: 280 });
        setToast(tr(language(), "正在播放铃声", "Playing tone"));
        break;
      }
      case "connectivity":
        if (cursor() === 0) {
          setScreen("wifi");
          scanWifi();
        } else if (cursor() === 1) scanBluetooth("ble");
        else scanBluetooth("classic");
        break;
      case "wifi": {
        const item = wifi()[cursor()];
        if (!item) {
          scanWifi();
          break;
        }
        setSelectedSsid(item.ssid);
        setPassword("");
        setKeyboardRow(0);
        setKeyboardCol(0);
        setScreen("wifiPassword");
        break;
      }
      case "wifiPassword":
        selectKeyboardKey();
        break;
      case "wifiSave": {
        const save = wifiSaveChoice() === 1;
        if (shouldPersistWifi(true, save)) {
          command("wifi.save", { ssid: selectedSsid(), password: password() });
        }
        setToast(save ? tr(language(), "连接已保存", "Connection saved") : tr(language(), "本次不保存", "Not saved"));
        setScreen("wifi");
        break;
      }
      case "bluetooth": {
        const item = radio()[cursor()];
        if (item) command("bluetooth.select", item);
        setToast(item ? item.address : tr(language(), "未发现设备", "No device"));
        break;
      }
      case "hardware": {
        const actions = ["led1", "led2", "buzzer", "motor1", "motor2", "gpio", "allOff"];
        const action = actions[cursor()];
        if (action === "allOff") command("output.allOff");
        else if (action === "buzzer") command("tone.play", { frequency: 880, durationMs: 180 });
        else if (action === "motor1" || action === "motor2") {
          command("motor.pulse", { channel: action === "motor1" ? 1 : 2, power: 25, durationMs: 500 });
        } else command("output.toggle", { target: action });
        break;
      }
      case "settings":
        if (cursor() === 0) {
          const next = nextLanguage(language());
          setLanguage(next);
          command("settings.language", { language: next });
        } else if (cursor() === 1) command("settings.rotation", { rotation: 3 });
        else if (cursor() === 2) command("wifi.forget");
        else if (cursor() === 3) command("storage.prepare");
        else {
          setLanguage("zh");
          command("settings.defaults");
        }
        setToast(tr(language(), "设置已应用", "Setting applied"));
        break;
      case "quick":
        if (quickCursor() === 0) returnHome();
        else if (quickCursor() === 1) command("tone.play", { frequency: 1047, durationMs: 120 });
        else if (quickCursor() === 2) command("output.allOff");
        else {
          const next = nextLanguage(language());
          setLanguage(next);
          command("settings.language", { language: next });
        }
        break;
      default:
        break;
    }
  };

  const processEvent = (event: DeviceEvent) => {
    setBusy(false);
    if (!event.ok) {
      setToast(event.error ?? tr(language(), "操作失败", "Operation failed"));
      return;
    }
    if (event.type === "wifi.scan") {
      const data = (event.data ?? []) as WifiItem[];
      setWifi(data);
      setToast(data.length ? "" : tr(language(), "没有找到 WLAN", "No WLAN found"));
    } else if (event.type === "wifi.connect") {
      setWifiSaveChoice(0);
      setScreen("wifiSave");
      setToast("");
    } else if (event.type === "radio.scan") {
      const data = (event.data ?? []) as RadioItem[];
      setRadio(data);
      setToast(data.length ? "" : tr(language(), "没有找到设备", "No devices found"));
    } else if (event.type === "storage.list") {
      setFiles((event.data ?? []) as string[]);
    } else if (event.type === "alarm.fire") {
      setToast(tr(language(), "提醒时间到", "Alarm"));
      command("tone.play", { frequency: 880, durationMs: 600 });
    } else if (event.type === "bluetooth.message") {
      const data = event.data as { text?: string };
      setMessages((value) => [...value, `Inbox: ${data.text ?? ""}`]);
    } else {
      setToast(tr(language(), "完成", "Done"));
    }
  };

  onButtonPress(BTN.SELECT, returnHome);
  onButtonPress(BTN.START, () => {
    if (screen() === "hardware") {
      command("output.unlock", { leaseMs: 30000 });
      setToast(tr(language(), "输出已解锁 30 秒", "Outputs unlocked 30s"));
    } else {
      setQuickCursor(0);
      setScreen("quick");
    }
  });
  onButtonPress(BTN.CIRCLE, () => {
    if (screen() === "wifiPassword") {
      if (password()) setPassword((value) => value.slice(0, -1));
      else goBack();
    } else if (screen() === "calculator" && calculatorText()) {
      setCalculatorText((value) => value.slice(0, -1));
    } else {
      goBack();
    }
  });
  onButtonPress(BTN.CROSS, activate);
  onButtonPress(BTN.UP, () => {
    if (screen() === "home") setHomeSelected((value) => moveGrid(value, "up", APP_CATALOG.length, 3));
    else if (screen() === "wifiPassword") moveKeyboard("up");
    else if (screen() === "calculator") setCalcCursor((value) => (value + 12) % 16);
    else if (screen() === "wifiSave") setWifiSaveChoice((value) => value ? 0 : 1);
    else if (screen() === "snake") setDirection("up");
    else if (screen() === "quick") setQuickCursor((value) => (value + 3) % 4);
    else moveSelection(-1);
  });
  onButtonPress(BTN.DOWN, () => {
    if (screen() === "home") setHomeSelected((value) => moveGrid(value, "down", APP_CATALOG.length, 3));
    else if (screen() === "wifiPassword") moveKeyboard("down");
    else if (screen() === "calculator") setCalcCursor((value) => (value + 4) % 16);
    else if (screen() === "wifiSave") setWifiSaveChoice((value) => value ? 0 : 1);
    else if (screen() === "snake") setDirection("down");
    else if (screen() === "quick") setQuickCursor((value) => (value + 1) % 4);
    else moveSelection(1);
  });
  onButtonPress(BTN.LEFT, () => {
    if (screen() === "home") setHomeSelected((value) => moveGrid(value, "left", APP_CATALOG.length, 3));
    else if (screen() === "wifiPassword") moveKeyboard("left");
    else if (screen() === "calculator") setCalcCursor((value) => Math.floor(value / 4) * 4 + (value + 3) % 4);
    else if (screen() === "wifiSave") setWifiSaveChoice(0);
    else if (screen() === "snake") setDirection("left");
  });
  onButtonPress(BTN.RIGHT, () => {
    if (screen() === "home") setHomeSelected((value) => moveGrid(value, "right", APP_CATALOG.length, 3));
    else if (screen() === "wifiPassword") moveKeyboard("right");
    else if (screen() === "calculator") setCalcCursor((value) => Math.floor(value / 4) * 4 + (value + 1) % 4);
    else if (screen() === "wifiSave") setWifiSaveChoice(1);
    else if (screen() === "snake") setDirection("right");
  });

  let frame = 0;
  let languageHydrated = false;
  onFrame(() => {
    frame += 1;
    if (frame % 6 === 0) {
      const next = sensorSnapshot();
      setSnapshot(next);
      if (!languageHydrated) {
        setLanguage(next.language);
        languageHydrated = true;
      }
    }
    for (const event of pollEvents()) processEvent(event);
    if (screen() === "snake" && frame % 8 === 0) {
      setSnake((state) => moveSnake(state, 20, 10));
    }
  });

  const connectivityItems = () => [
    tr(language(), "WLAN 扫描", "WLAN scan"),
    tr(language(), "蓝牙低功耗", "Bluetooth LE"),
    tr(language(), "经典蓝牙", "Bluetooth Classic"),
  ];
  const hardwareItems = () => [
    tr(language(), "可编程灯 1", "Programmable LED 1"),
    tr(language(), "可编程灯 2", "Programmable LED 2"),
    tr(language(), "蜂鸣器", "Buzzer"),
    "M1 · 500ms",
    "M2 · 500ms",
    tr(language(), "扩展口状态", "Expansion ports"),
    tr(language(), "全部关闭", "All outputs off"),
  ];
  const settingsItems = () => [
    `${tr(language(), "语言", "Language")}: ${language() === "zh" ? "中文" : "English"}`,
    tr(language(), "屏幕方向：横向", "Display: landscape"),
    tr(language(), "忘记 WLAN", "Forget WLAN"),
    tr(language(), "准备存储目录", "Prepare storage"),
    tr(language(), "恢复界面设置", "Reset UI settings"),
  ];
  const calcKeys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "=", "+"];

  return (
    <Chrome
      title={title()}
      language={language()}
      snapshot={snapshot()}
      busy={busy()}
      left={screen() === "home" ? tr(language(), "选项", "Options") : undefined}
      center={screen() === "wifiPassword" ? tr(language(), "输入", "Type") : "A"}
      right={screen() === "home" ? tr(language(), "退出", "Exit") : undefined}
    >
      <Show when={screen() === "home"}>
        <HomeGrid
          language={language()}
          selected={homeSelected()}
          onPage={homePage()}
          pageStart={homePageStart()}
        />
        <View class="absolute bottom-[1] right-[3] h-[12] px-[2] bg-[#123f6b] rounded-sm">
          <Text class="text-xs text-white">{Math.floor(homeSelected() / 9) + 1}/2</Text>
        </View>
      </Show>

      <Show when={screen() === "contacts"}>
        <ListPage items={contacts()} selected={cursor()} empty={tr(language(), "没有名片", "No contacts")} />
      </Show>
      <Show when={screen() === "messages"}>
        <ListPage items={messages()} selected={cursor()} empty={tr(language(), "没有信息", "No messages")} />
      </Show>
      <Show when={screen() === "calendar"}>
        <InfoRows rows={[
          [tr(language(), "日期", "Date"), "2026-07-27"],
          [tr(language(), "星期", "Day"), tr(language(), "星期一", "Monday")],
          [tr(language(), "下个提醒", "Next alarm"), tr(language(), "按 A 添加", "A to add")],
          [tr(language(), "时区", "Timezone"), "Asia/Shanghai"],
        ]} />
      </Show>
      <Show when={screen() === "alarms"}>
        <ListPage
          items={alarms()}
          selected={cursor()}
          empty={tr(language(), "按 A 添加闹钟", "Press A to add an alarm")}
        />
      </Show>
      <Show when={screen() === "notes"}>
        <ListPage items={notes()} selected={cursor()} empty={tr(language(), "没有记事", "No notes")} />
      </Show>
      <Show when={screen() === "calculator"}>
        <View class="h-[22] mx-[3] mt-[2] px-[3] flex-row items-center justify-end bg-white border-[#71879a] overflow-hidden">
          <Text class="text-xs font-bold text-[#102d4b]">{calculatorText() || "0"}</Text>
        </View>
        <View class="flex-1 flex-row flex-wrap justify-center py-[2]">
          <For each={calcKeys}>
            {(key, index) => (
              <View class={index() === calcCursor()
                ? "w-[37] h-[15] items-center justify-center bg-gradient-to-b from-[#5aaee4] to-[#1769aa] border-white"
                : "w-[37] h-[15] items-center justify-center bg-gradient-to-b from-[#ffffff] to-[#cbd7e0] border-[#8499aa]"}>
                <Text class={index() === calcCursor() ? "text-xs font-bold text-white" : "text-xs font-bold text-[#102d4b]"}>
                  {key}
                </Text>
              </View>
            )}
          </For>
        </View>
      </Show>
      <Show when={screen() === "files"}>
        <ListPage items={files()} selected={cursor()} empty={tr(language(), "目录为空", "Folder is empty")} />
      </Show>
      <Show when={screen() === "gallery"}>
        <ListPage items={files()} selected={cursor()} empty={tr(language(), "没有媒体文件", "No media files")} />
      </Show>
      <Show when={screen() === "music"}>
        <ListPage
          items={["Nokia rise", "Pocket bell", "Blue note", "Digital call", "Classic beep"]}
          details={["523Hz", "659Hz", "784Hz", "880Hz", "1047Hz"]}
          selected={cursor()}
          empty=""
        />
      </Show>
      <Show when={screen() === "snake"}>
        <SnakeBoard state={snake()} />
        <View class="absolute top-[1] left-[3] px-[2] bg-[#405027]">
          <Text class="text-xs font-bold text-white">{snake().alive ? `S:${snake().score}` : "GAME OVER"}</Text>
        </View>
      </Show>
      <Show when={screen() === "connectivity"}>
        <ListPage items={connectivityItems()} selected={cursor()} empty="" />
      </Show>
      <Show when={screen() === "wifi"}>
        <ListPage
          items={wifi().map((item) => item.ssid || "<hidden>")}
          details={wifi().map((item) => `${item.rssi} ${item.secure ? "*" : ""}`)}
          selected={cursor()}
          empty={toast() || tr(language(), "按 A 重新扫描", "A to scan")}
        />
      </Show>
      <Show when={screen() === "wifiPassword"}>
        <Keyboard
          language={language()}
          row={keyboardRow()}
          col={keyboardCol()}
          text={password()}
        />
      </Show>
      <Show when={screen() === "wifiSave"}>
        <View class="flex-1 flex-col items-center justify-center px-[8]">
          <Text class="text-xs font-bold text-[#102d4b]">
            {tr(language(), "连接成功，保存密码？", "Connected. Save password?")}
          </Text>
          <View class="h-[22] flex-row mt-[6]">
            <View class={wifiSaveChoice() === 0
              ? "w-[60] items-center justify-center bg-[#1769aa] border-white"
              : "w-[60] items-center justify-center bg-[#d8e3eb] border-[#8499aa]"}>
              <Text class={wifiSaveChoice() === 0 ? "text-xs font-bold text-white" : "text-xs text-[#102d4b]"}>
                {tr(language(), "否", "No")}
              </Text>
            </View>
            <View class={wifiSaveChoice() === 1
              ? "w-[60] items-center justify-center bg-[#1769aa] border-white"
              : "w-[60] items-center justify-center bg-[#d8e3eb] border-[#8499aa]"}>
              <Text class={wifiSaveChoice() === 1 ? "text-xs font-bold text-white" : "text-xs text-[#102d4b]"}>
                {tr(language(), "是", "Yes")}
              </Text>
            </View>
          </View>
        </View>
      </Show>
      <Show when={screen() === "bluetooth"}>
        <ListPage
          items={radio().map((item) => item.name || item.address)}
          details={radio().map((item) => `${item.rssi}`)}
          selected={cursor()}
          empty={toast() || tr(language(), "没有找到设备", "No devices found")}
        />
      </Show>
      <Show when={screen() === "sensors"}>
        <InfoRows rows={[
          [tr(language(), "光照 ADC", "Light ADC"), `${snapshot().lightRaw}`],
          [tr(language(), "温度", "Temperature"), `${snapshot().temperatureC.toFixed(1)} C`],
          ["IMU 0x68", snapshot().imuAvailable ? "READY" : tr(language(), "未装配", "Not fitted")],
          ["Accel X/Y", snapshot().imuAvailable ? `${snapshot().accel[0].toFixed(2)} ${snapshot().accel[1].toFixed(2)}` : "--"],
          ["Pitch / Roll", snapshot().imuAvailable ? `${snapshot().pitch.toFixed(1)} / ${snapshot().roll.toFixed(1)}` : "--"],
          ["Gyro Z", snapshot().imuAvailable ? `${snapshot().gyro[2].toFixed(1)}` : "--"],
        ]} />
      </Show>
      <Show when={screen() === "hardware"}>
        <ListPage
          items={hardwareItems()}
          details={[
            snapshot().controllerAvailable ? "0x40" : "--",
            snapshot().controllerAvailable ? "0x40" : "--",
            "",
            snapshot().outputsUnlocked ? "READY" : "LOCK",
            snapshot().outputsUnlocked ? "READY" : "LOCK",
            "33 32 26 25",
            "",
          ]}
          selected={cursor()}
          empty=""
        />
      </Show>
      <Show when={screen() === "settings"}>
        <ListPage items={settingsItems()} selected={cursor()} empty="" />
        <View class="absolute bottom-[1] right-[3]">
          <Text class="text-xs text-[#566675]">v0.1.0</Text>
        </View>
      </Show>
      <Show when={screen() === "quick"}>
        <View class="absolute inset-[8] flex-col p-[3] rounded-md bg-gradient-to-b from-[#f8fafc] to-[#b9cad8] border-[#355d7c] shadow-md animate-s60-menu-in">
          <ListPage
            items={[
              tr(language(), "主屏幕", "Home"),
              tr(language(), "提示音", "Key tone"),
              tr(language(), "紧急关闭输出", "All outputs off"),
              tr(language(), "切换语言", "Switch language"),
            ]}
            selected={quickCursor()}
            empty=""
          />
        </View>
      </Show>

      <Show when={toast() && screen() !== "wifi" && screen() !== "bluetooth"}>
        <View class="absolute left-[8] right-[8] bottom-[2] h-[16] flex-row items-center justify-center rounded-sm bg-[#102d4b] border-white">
          <Text class="text-xs font-bold text-white">{toast()}</Text>
        </View>
      </Show>
    </Chrome>
  );
}
