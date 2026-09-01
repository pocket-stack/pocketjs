import { Show, createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";

/** The transport mode reported by the PocketRock USB service. */
export type UsbMode = "mass-storage" | "charging" | "idle";

/**
 * A single bounded transfer snapshot. `progress` is a fraction in the range
 * 0..1; keeping that contract here means the page never has to guess whether
 * a service is reporting percent or bytes.
 */
export interface UsbTransfer {
  active: boolean;
  progress: number;
  fileName?: string;
  bytesTransferred?: number;
  totalBytes?: number;
  direction?: "sending" | "receiving";
}

/**
 * Props for the 320x240 USB page. It is intentionally state-only: a Click
 * Wheel host can update these values without a touch or gesture dependency.
 */
export interface UsbPageProps {
  connected: boolean;
  mode?: UsbMode;
  canEject?: boolean;
  transfer?: UsbTransfer;
  title?: string;
  /** Called by an optional Select/focus host when safe removal is requested. */
  onEject?: () => void;
}

const MODE_LABEL: Record<UsbMode, string> = {
  "mass-storage": "MASS STORAGE",
  charging: "CHARGING",
  idle: "READY",
};

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function Header(props: { title: string }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

/** A compact USB trident built from host rectangles, so no bitmap asset is needed. */
function UsbGlyph(props: { connected: boolean; pulse: number }) {
  const color = () => props.connected ? "#2378d4" : "#8b96a5";
  const dark = () => props.connected ? "#1c2d44" : "#697587";
  return (
    <View class="absolute left-[14] top-[16] w-[90] h-[106] rounded-[8] bg-[#e1e6eb] border border-[#c1c9d2]">
      <View class="absolute left-[43] top-[22] w-[4] h-[51] rounded-[2]" style={{ bgColor: color(), opacity: props.pulse }} />
      <View class="absolute left-[29] top-[45] w-[31] h-[4] rounded-[2]" style={{ bgColor: color(), rotate: -38, originX: 0.5, originY: 0.5 }} />
      <View class="absolute left-[47] top-[45] w-[31] h-[4] rounded-[2]" style={{ bgColor: color(), rotate: 38, originX: 0.5, originY: 0.5 }} />
      <View class="absolute left-[36] top-[69] w-[18] h-[24] rounded-[3]" style={{ bgColor: dark() }} />
      <View class="absolute left-[39] top-[74] w-[12] h-[4] rounded-[1] bg-[#e1e6eb]" />
      <Text class="absolute left-[24] top-[8] w-[44] text-center text-xs text-[#607086] font-bold tracking-wide">USB</Text>
      <Text class="absolute left-[39] top-[28] text-sm text-white font-bold" style={{ color: color(), opacity: props.pulse }}>▼</Text>
    </View>
  );
}

function TransferCard(props: { connected: boolean; transfer?: UsbTransfer; dots: string }) {
  const transfer = () => props.transfer;
  const active = () => props.connected && Boolean(transfer()?.active);
  const progress = createMemo(() => clampProgress(transfer()?.progress ?? 0));
  const percent = createMemo(() => `${Math.round(progress() * 100)}%`);
  const detail = createMemo(() => {
    const current = formatBytes(transfer()?.bytesTransferred);
    const total = formatBytes(transfer()?.totalBytes);
    if (current && total) return `${current} / ${total}`;
    return current || total;
  });
  const direction = createMemo(() => transfer()?.direction === "sending" ? "TO IPOD" : "FROM IPOD");

  return (
    <View class="absolute left-[14] top-[133] w-[292] h-[52] flex-col justify-center px-[10] rounded-[7] bg-white border border-[#c5ccd4]">
      <Show when={active()} fallback={
        <View class="flex-row items-center justify-between">
          <Text class="text-xs text-[#596a7f] font-bold">TRANSFER</Text>
          <Text class="text-xs text-[#7c8794]">{props.connected ? "READY" : "NO CABLE"}</Text>
        </View>
      }>
        <View class="flex-row items-center justify-between">
          <Text class="text-xs text-[#2378d4] font-bold">TRANSFERRING{props.dots}</Text>
          <Text class="text-xs text-[#52657b]">{direction()}  {percent()}</Text>
        </View>
        <View class="relative mt-[5] w-[270] h-[6] rounded-[3] bg-[#dfe4e9] overflow-hidden">
          <View class="absolute left-0 top-0 h-[6] rounded-[3] bg-gradient-to-r from-[#2378d4] to-[#55a6ee]" style={{ width: progress() * 270 }} />
        </View>
        <View class="mt-[3] flex-row items-center justify-between">
          <Text class="w-[205] text-xs text-[#687586]">{transfer()?.fileName ?? "USB transfer"}</Text>
          <Text class="text-xs text-[#8893a0]">{detail()}</Text>
        </View>
      </Show>
    </View>
  );
}

/** PocketRock's iPod Classic USB connection surface. */
export default function UsbPage(props: UsbPageProps) {
  const [frame, setFrame] = createSignal(0);
  onFrame(() => setFrame((value) => (value + 1) % 48));

  const mode = createMemo(() => props.mode ?? (props.connected ? "mass-storage" : "idle"));
  const modeLabel = createMemo(() => MODE_LABEL[mode()]);
  const pulse = createMemo(() => 0.72 + Math.sin(frame() / 6) * 0.28);
  const dots = createMemo(() => ".".repeat((frame() % 3) + 1));
  const canEject = createMemo(() => props.connected && (props.canEject ?? false));

  return (
    <View class="relative w-[320] h-[240] bg-[#f1f3f5] overflow-hidden">
      <Header title={props.title ?? "USB Connection"} />
      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#eef1f4] overflow-hidden">
        <UsbGlyph connected={props.connected} pulse={pulse()} />

        <View class="absolute left-[116] top-[12] w-[190] h-[106] flex-col px-[11] pt-[10] rounded-[8] bg-white border border-[#c5ccd4]">
          <View class="flex-row items-center">
            <View class="w-[8] h-[8] rounded-full" style={{ bgColor: props.connected ? "#2eaf70" : "#9aa4b0", opacity: pulse() }} />
            <Text class="ml-[6] text-xs text-[#667589] font-bold tracking-wide">USB CONNECTION</Text>
          </View>
          <Text class="mt-[6] text-lg text-[#182536] font-bold">{props.connected ? "CONNECTED" : "NOT CONNECTED"}</Text>
          <View class="mt-[5] w-[168] h-[1] bg-[#e0e4e8]" />
          <View class="mt-[6] flex-row items-center justify-between">
            <Text class="text-xs text-[#758294]">MODE</Text>
            <Text class="text-xs text-[#2378d4] font-bold">{modeLabel()}</Text>
          </View>
          <Text class="mt-[4] text-xs text-[#687586]">
            {props.connected ? "Cable and host are ready" : "Connect the USB cable to begin"}
          </Text>
        </View>

        <TransferCard connected={props.connected} transfer={props.transfer} dots={dots()} />

        <Show when={props.connected}>
          <View class="absolute left-[14] top-[188] flex-row items-center">
            <Text class="text-xs text-[#596a7f]">{canEject() ? "SELECT" : "STATUS"}</Text>
            <Text class="ml-[5] text-xs text-[#7b8795]">
              {canEject() ? "Eject safely before unplugging" : "Keep cable connected while active"}
            </Text>
          </View>
          <Show when={canEject() && props.onEject}>
            <View
              class="absolute right-[14] top-[185] h-[17] px-[6] flex-row items-center rounded-[3] bg-[#dce8f5] border border-[#a9c8e7] focus:bg-[#c4dcf2]"
              focusable
              onPress={() => props.onEject?.()}
            >
              <Text class="text-xs text-[#1f63a5] font-bold">EJECT</Text>
            </View>
          </Show>
        </Show>
        <Show when={!props.connected}>
          <Text class="absolute left-[14] top-[188] text-xs text-[#7b8795]">USB cable not detected</Text>
        </Show>
      </View>
    </View>
  );
}
