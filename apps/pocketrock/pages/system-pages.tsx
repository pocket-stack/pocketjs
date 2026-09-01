import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** The small, host-neutral subset of battery data needed by PowerPage. */
export interface PowerSnapshot {
  batteryPercent?: number;
  batteryMinutes?: number | null;
  charging?: boolean;
}

export type PowerAction = "sleep" | "powerOff" | "reboot";

export interface PowerPageProps {
  snapshot?: PowerSnapshot;
  /** Index of the highlighted action (0 = Sleep, 1 = Power off, 2 = Restart). */
  selectedAction?: number;
  /** Called when an action is activated. It is an observation/dispatch hook only. */
  onAction?: (action: PowerAction) => void;
  onSleep?: () => void;
  onPowerOff?: () => void;
  onReboot?: () => void;
  onBack?: () => void;
}

export interface StorageSnapshot {
  freeBytes?: number;
  totalBytes?: number;
}

export interface StoragePageProps {
  snapshot?: StorageSnapshot;
  onBack?: () => void;
  onRefresh?: () => void;
}

export interface SystemInformation {
  pocketRockVersion?: string;
  rockboxVersion?: string;
  quickJsVersion?: string;
  abiVersion?: string | number;
  deviceModel?: string;
  deviceName?: string;
  deviceSerial?: string;
}

export interface SystemInformationPageProps {
  info?: SystemInformation;
  onBack?: () => void;
}

const SCREEN = "relative w-[320] h-[240] overflow-hidden bg-[#f5f6f8]";
const BAR = "absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]";
const CONTENT = "absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden";
const ROW = "relative w-[320] h-[35] flex-row items-center justify-between pl-[12] pr-[10]";
const DIVIDER = "absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]";

function Header(props: { title: string; onBack?: () => void }) {
  return (
    <View class={BAR}>
      <Show when={props.onBack}>
        <View
          class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]"
          focusable
          onPress={props.onBack}
        >
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function percent(value: number | undefined): number {
  return Math.round(Math.min(100, Math.max(0, finite(value, 0))));
}

function remaining(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "Time unavailable";
  const rounded = Math.floor(minutes);
  if (rounded < 1) return "Less than 1 min";
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return hours > 0 ? `${hours}h ${String(mins).padStart(2, "0")}m` : `${mins} min`;
}

function PowerActionRow(props: {
  label: string;
  hint: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <View
      class={props.selected ? `${ROW} bg-[#2378d4]` : ROW}
      focusable
      onPress={props.onPress}
    >
      <Text class={props.selected ? "text-sm text-white font-bold" : "text-sm text-[#18202a] font-bold"}>{props.label}</Text>
      <Text class={props.selected ? "text-xs text-[#e6f1ff]" : "text-xs text-[#697586]"}>{props.hint}</Text>
      <View class={props.selected ? "absolute left-0 right-0 bottom-0 h-[1] bg-[#1461b0]" : DIVIDER} />
    </View>
  );
}

/**
 * Power controls for the 320x240 PocketRock shell.
 *
 * The page never calls the Rockbox power service. Every potentially disruptive
 * operation is exposed as a callback so the shell can confirm or dispatch it.
 */
export function PowerPage(props: PowerPageProps) {
  const level = () => percent(props.snapshot?.batteryPercent);
  const action = (value: PowerAction) => {
    const handler = value === "sleep" ? props.onSleep
      : value === "powerOff" ? props.onPowerOff
      : props.onReboot;
    if (handler) handler();
    else props.onAction?.(value);
  };

  return (
    <View class={SCREEN}>
      <Header title="Power" onBack={props.onBack} />
      <View class={CONTENT}>
        <View class="absolute left-[12] top-[10] w-[296] h-[38] flex-row items-center">
          <View class="w-[39] h-[20] p-[2] rounded-[3] border border-[#405166] bg-[#d4dbe4]">
            <View class="h-[14] rounded-[1] bg-[#4e9b58]" style={{ width: `${Math.round(33 * level() / 100)}` }} />
          </View>
          <View class="ml-[9] flex-col">
            <Text class="text-sm text-[#18202a] font-bold">Battery {level()}%</Text>
            <Text class="text-xs text-[#697586]">{props.snapshot?.charging ? "Charging" : "On battery"}</Text>
          </View>
          <Text class="absolute right-0 top-[3] text-xs text-[#405166]">{remaining(props.snapshot?.batteryMinutes)}</Text>
        </View>
        <View class="absolute left-0 top-[48] w-[320] h-[1] bg-[#cdd4dd]" />
        <View class="absolute left-0 top-[49] w-[320] flex-col">
          <PowerActionRow label="Sleep" hint="Lock and dim" selected={props.selectedAction === 0} onPress={() => action("sleep")} />
          <PowerActionRow label="Power off" hint="Shut down player" selected={props.selectedAction === 1} onPress={() => action("powerOff")} />
          <PowerActionRow label="Restart" hint="Reload PocketRock" selected={props.selectedAction === 2} onPress={() => action("reboot")} />
        </View>
        <Text class="absolute left-[12] bottom-[7] text-xs text-[#697586]">SELECT choose  ·  MENU back</Text>
      </View>
    </View>
  );
}

function bytes(value: number | undefined): string {
  const amount = Math.max(0, finite(value, 0));
  if (amount < 1024) return `${Math.round(amount)} B`;
  if (amount < 1048576) return `${(amount / 1024).toFixed(1)} KiB`;
  if (amount < 1073741824) return `${(amount / 1048576).toFixed(1)} MiB`;
  return `${(amount / 1073741824).toFixed(2)} GiB`;
}

/** Storage usage surface. Values are read-only; refresh is optional and host-owned. */
export function StoragePage(props: StoragePageProps) {
  const total = () => Math.max(0, finite(props.snapshot?.totalBytes, 0));
  const free = () => Math.min(total(), Math.max(0, finite(props.snapshot?.freeBytes, 0)));
  const used = () => Math.max(0, total() - free());
  const usedWidth = () => total() > 0 ? Math.round(296 * used() / total()) : 0;

  return (
    <View class={SCREEN}>
      <Header title="Storage" onBack={props.onBack} />
      <View class={CONTENT}>
        <View class="absolute left-[12] top-[14] w-[296] h-[49]">
          <View class="flex-row justify-between items-center">
            <Text class="text-sm text-[#18202a] font-bold">Player storage</Text>
            <Show when={props.onRefresh}>
              <View class="px-[6] h-[20] flex-row items-center rounded-[3] bg-[#dce3eb] border border-[#b9c4d1]" focusable onPress={props.onRefresh}>
                <Text class="text-xs text-[#405166] font-bold">Refresh</Text>
              </View>
            </Show>
          </View>
          <View class="absolute left-0 top-[27] w-[296] h-[10] p-[1] rounded-[3] bg-[#d7dde5] border border-[#aab5c3] overflow-hidden">
            <View class="h-[6] rounded-[1] bg-[#2378d4]" style={{ width: usedWidth() }} />
          </View>
        </View>
        <View class="absolute left-[12] top-[76] w-[296] flex-col">
          <View class={ROW}>
            <Text class="text-sm text-[#18202a]">Used</Text>
            <Text class="text-sm text-[#405166] font-bold">{bytes(used())}</Text>
            <View class={DIVIDER} />
          </View>
          <View class={ROW}>
            <Text class="text-sm text-[#18202a]">Free</Text>
            <Text class="text-sm text-[#405166] font-bold">{bytes(free())}</Text>
            <View class={DIVIDER} />
          </View>
          <View class={ROW}>
            <Text class="text-sm text-[#18202a]">Total</Text>
            <Text class="text-sm text-[#405166] font-bold">{bytes(total())}</Text>
          </View>
        </View>
        <Text class="absolute left-[12] bottom-[7] text-xs text-[#697586]">Free {bytes(free())}  ·  Total {bytes(total())}</Text>
      </View>
    </View>
  );
}

function infoValue(value: string | number | undefined): string {
  const text = value == null ? "—" : String(value).trim();
  return text || "—";
}

function InfoRow(props: { label: string; value: string | number | undefined; last?: boolean }) {
  return (
    <View class={ROW}>
      <Text class="text-sm text-[#18202a]">{props.label}</Text>
      <Text class="text-xs text-[#405166] font-bold">{infoValue(props.value)}</Text>
      <Show when={!props.last}><View class={DIVIDER} /></Show>
    </View>
  );
}

/** Read-only build and device facts for support/debugging on the player. */
export function SystemInformationPage(props: SystemInformationPageProps) {
  const info = () => props.info ?? {};
  return (
    <View class={SCREEN}>
      <Header title="System Information" onBack={props.onBack} />
      <View class={CONTENT}>
        <View class="absolute left-0 top-[7] w-[320] flex-col">
          <InfoRow label="PocketRock" value={info().pocketRockVersion} />
          <InfoRow label="Rockbox" value={info().rockboxVersion} />
          <InfoRow label="QuickJS" value={info().quickJsVersion} />
          <InfoRow label="Host ABI" value={info().abiVersion} />
          <InfoRow label="Device" value={info().deviceModel} />
          <InfoRow label="Name" value={info().deviceName} />
          <InfoRow label="Serial" value={info().deviceSerial} last />
        </View>
        <Text class="absolute left-[12] bottom-[7] text-xs text-[#697586]">PocketRock runtime · read only</Text>
      </View>
    </View>
  );
}

export default SystemInformationPage;
