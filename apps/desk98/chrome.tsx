// apps/desk98/chrome.tsx — presentational Windows 98 chrome. Every component
// here only paints; the compositor (app.tsx) owns hit testing and routes all
// pointer/keyboard input itself off the svc mouse stream, so nothing in this
// file registers a handler. Geometry mirrors wm.ts via theme.ts constants.
//
// Class strings are FULL literals throughout — the style table compiles at
// build time and template-interpolated fragments are a compile error, so the
// bevel recipes repeat verbatim instead of riding shared constants.

import { For, Show, type JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { CAPTION_ACTIVE, CAPTION_INACTIVE, FONT, FONT_B, FONT_XL } from "./theme.ts";
import type { CaptionButton } from "./wm.ts";
import type { DeskIcon, Popup, TaskEntry, WinCtl } from "./state.ts";

/** W95FA text. Slots 19/20/21 ride the style prop — the class table never
 *  sees them (baked per-app via pak.json, docs in gen-assets.ts). */
export function T98(props: {
  class?: string;
  bold?: boolean;
  xl?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Text
      class={props.class ?? "text-[#000000]"}
      style={{ fontSlot: props.xl ? FONT_XL : props.bold ? FONT_B : FONT }}
    >
      {props.children}
    </Text>
  );
}

const BTN_ICON: Record<CaptionButton, string> = {
  min: "icons/cap-min.svg",
  max: "icons/cap-max.svg",
  close: "icons/cap-close.svg",
};

/** One window: raised frame, caption gradient, controls, menu bar, content.
 *  Position/size ride the style prop — translate moves are paint-only, and
 *  zIndex raises without reordering siblings (a reorder would rebuild the
 *  whole layout tree). */
export function Window98(props: {
  win: WinCtl;
  active: boolean;
  children: JSX.Element;
}): JSX.Element {
  const w = props.win;
  return (
    <View
      class="absolute flex-col bg-[#c0c0c0] p-[3] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
      style={{
        insetL: 0,
        insetT: 0,
        width: w.geo().w,
        height: w.geo().h,
        translateX: w.geo().x,
        translateY: w.geo().y,
        zIndex: w.z(),
        opacity: w.minimized() ? 0 : 1,
      }}
    >
      <View class={props.active ? CAPTION_ACTIVE : CAPTION_INACTIVE}>
        <Image class="w-[16] h-[16] mr-[3]" src={w.icon} />
        <View class="flex-1 flex-row overflow-hidden">
          <T98 bold class={props.active ? "text-[#ffffff]" : "text-[#c0c0c0]"}>
            {w.title}
          </T98>
        </View>
        <CaptionButtons win={w} />
      </View>
      <Show when={w.menus !== null}>
        <View class="flex-row items-center h-[18] bg-[#c0c0c0]">
          <For each={w.menus ?? []}>
            {(menu, i) => (
              <View
                class={
                  w.openMenu() === i()
                    ? "h-[17] px-[6] flex-col justify-center bg-[#000080]"
                    : "h-[17] px-[6] flex-col justify-center"
                }
              >
                <T98 class={w.openMenu() === i() ? "text-[#ffffff]" : "text-[#000000]"}>
                  {menu.label}
                </T98>
              </View>
            )}
          </For>
        </View>
      </Show>
      <View class="flex-1 flex-col overflow-hidden">{props.children}</View>
    </View>
  );
}

function CaptionButtons(props: { win: WinCtl }): JSX.Element {
  // Render mirrors wm.ts captionButtonXs: min/zoom adjacent, close 2px apart.
  return (
    <View class="flex-row items-center">
      <For each={props.win.buttons}>
        {(btn, i) => {
          const pressed = () => props.win.pressedBtn() === btn;
          const gapped = btn === "close" && i() > 0;
          return (
            <View
              class={
                gapped
                  ? pressed()
                    ? "w-[16] h-[14] ml-[2] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
                    : "w-[16] h-[14] ml-[2] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
                  : pressed()
                    ? "w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
                    : "w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
              }
            >
              <Image
                class={pressed() ? "w-[8] h-[8] ml-[1] mt-[1]" : "w-[8] h-[8]"}
                src={
                  btn === "max" && props.win.maximized()
                    ? "icons/cap-restore.svg"
                    : BTN_ICON[btn]
                }
              />
            </View>
          );
        }}
      </For>
    </View>
  );
}

/** The taskbar: Start, one button per window, the sunken clock tray. */
export function Taskbar(props: {
  entries: TaskEntry[];
  activeId: number;
  startOpen: boolean;
  clock: string;
  buttonW: number;
}): JSX.Element {
  return (
    <View
      class="absolute left-0 right-0 bottom-0 h-[28] flex-row items-center bg-[#c0c0c0] bevel-[#ffffff,#808080] pl-[2] pr-[2] gap-[3]"
      style={{ zIndex: 10000 }}
    >
      <View
        class={
          props.startOpen
            ? "h-[22] w-[54] flex-row justify-center items-center gap-[3] bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
            : "h-[22] w-[54] flex-row justify-center items-center gap-[3] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
        }
      >
        <Image class="w-[16] h-[16]" src="icons/start-flag.svg" />
        <T98 bold>Start</T98>
      </View>
      <View class="w-[1] h-[22] bevel-[#808080,#ffffff]" />
      <View class="flex-1 flex-row items-center gap-[3] overflow-hidden">
        <For each={props.entries}>
          {(entry) => (
            <View
              class={
                entry.id === props.activeId
                  ? "h-[22] flex-row items-center gap-[4] px-[4] bg-[#dfdfdf] bevel-[#808080,#ffffff]"
                  : "h-[22] flex-row items-center gap-[4] px-[4] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
              }
              style={{ width: props.buttonW }}
            >
              <Image class="w-[16] h-[16]" src={entry.icon} />
              <View class="flex-1 flex-row overflow-hidden">
                <T98 bold={entry.id === props.activeId}>{entry.title}</T98>
              </View>
            </View>
          )}
        </For>
      </View>
      <View class="h-[22] flex-row items-center px-[8] bevel-[#808080,#ffffff]">
        <T98>{props.clock}</T98>
      </View>
    </View>
  );
}

/** Generic popup menu panel (context menus, dropdowns, start flyouts). */
export function PopupPanel(props: { popup: Popup; hover: number }): JSX.Element {
  return (
    <View
      class="absolute flex-col bg-[#c0c0c0] p-[1] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
      style={{
        insetL: 0,
        insetT: 0,
        translateX: props.popup.x,
        translateY: props.popup.y,
        width: props.popup.w,
        zIndex: 20000,
      }}
    >
      <For each={props.popup.items}>
        {(item, i) => (
          <Show
            when={!item.sep}
            fallback={
              <View class="h-[8] flex-col justify-center px-[1]">
                <View class="h-[1] bg-[#808080]" />
                <View class="h-[1] bg-[#ffffff]" />
              </View>
            }
          >
            <View
              class={
                props.hover === i() && !item.disabled
                  ? "h-[18] flex-row items-center gap-[5] pl-[4] pr-[8] bg-[#000080]"
                  : "h-[18] flex-row items-center gap-[5] pl-[4] pr-[8]"
              }
            >
              <Show when={item.icon} fallback={<View class="w-[16] h-[16]" />}>
                <Image class="w-[16] h-[16]" src={item.icon ?? ""} />
              </Show>
              <View class="flex-1 flex-row">
                <T98
                  class={
                    item.disabled
                      ? "text-[#808080]"
                      : props.hover === i()
                        ? "text-[#ffffff]"
                        : "text-[#000000]"
                  }
                >
                  {item.label}
                </T98>
              </View>
              <Show when={item.shortcut}>
                <T98
                  class={
                    item.disabled
                      ? "text-[#808080]"
                      : props.hover === i()
                        ? "text-[#ffffff]"
                        : "text-[#000000]"
                  }
                >
                  {item.shortcut ?? ""}
                </T98>
              </Show>
              <Show when={item.sub}>
                <Image class="w-[8] h-[8] ml-[2]" src="icons/menu-arrow.svg" />
              </Show>
            </View>
          </Show>
        )}
      </For>
    </View>
  );
}

/** The Start menu: navy banner + 26px rows (flyouts render as PopupPanels). */
export function StartMenu(props: {
  x: number;
  y: number;
  h: number;
  items: Popup["items"];
  hover: number;
}): JSX.Element {
  return (
    <View
      class="absolute flex-row bg-[#c0c0c0] p-[1] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
      style={{
        insetL: 0,
        insetT: 0,
        translateX: props.x,
        translateY: props.y,
        width: 182,
        height: props.h,
        zIndex: 19000,
      }}
    >
      <View class="w-[24] h-full bg-gradient-to-t from-[#000080] to-[#1084d0] flex-col justify-end items-center">
        {/* The box is laid out horizontally (wide enough that the label
            never wraps) and rotated to vertical at paint time. rotate is
            style-only: the class grammar's rotate-N takes no negative
            arbitrary value, and a bad token would silently void the whole
            literal. */}
        <View
          class="w-[124] h-[26] flex-col justify-center items-center"
          style={{ rotate: -90, translateY: -55 }}
        >
          <T98 xl class="text-[#ffffff]">
            PocketJS98
          </T98>
        </View>
      </View>
      <View class="flex-1 flex-col">
        <For each={props.items}>
          {(item, i) => (
            <Show
              when={!item.sep}
              fallback={
                <View class="h-[8] flex-col justify-center px-[2]">
                  <View class="h-[1] bg-[#808080]" />
                  <View class="h-[1] bg-[#ffffff]" />
                </View>
              }
            >
              <View
                class={
                  props.hover === i() && !item.disabled
                    ? "h-[26] flex-row items-center gap-[6] pl-[6] pr-[6] bg-[#000080]"
                    : "h-[26] flex-row items-center gap-[6] pl-[6] pr-[6]"
                }
              >
                <Image class="w-[16] h-[16]" src={item.icon ?? ""} />
                <View class="flex-1 flex-row">
                  <T98
                    class={
                      item.disabled
                        ? "text-[#808080]"
                        : props.hover === i()
                          ? "text-[#ffffff]"
                          : "text-[#000000]"
                    }
                  >
                    {item.label}
                  </T98>
                </View>
                <Show when={item.sub}>
                  <Image class="w-[8] h-[8]" src="icons/menu-arrow.svg" />
                </Show>
              </View>
            </Show>
          )}
        </For>
      </View>
    </View>
  );
}

/** Desktop icons: a left column of 32px art + label, teal behind. */
export function DesktopIcons(props: { icons: DeskIcon[]; selected: number }): JSX.Element {
  return (
    <View class="absolute left-0 top-0 flex-col gap-[10] p-[8]">
      <For each={props.icons}>
        {(icon, i) => (
          <View class="w-[74] flex-col items-center gap-[3]">
            <Image class="w-[32] h-[32]" src={icon.icon} />
            <View class={props.selected === i() ? "bg-[#000080] px-[2]" : "px-[2]"}>
              <T98 class="text-[#ffffff]">{icon.label}</T98>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}
