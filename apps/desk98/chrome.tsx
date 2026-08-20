// apps/desk98/chrome.tsx — presentational Windows 98 chrome, Vue Vapor JSX
// (vue-jsx-vapor; lists are plain .map() like every vapor JSX app in the
// repo). Every component here only paints; the compositor (app.tsx) owns hit
// testing and routes all pointer/keyboard input itself off the svc mouse
// stream, so nothing in this file registers a handler. Geometry mirrors
// wm.ts via theme.ts constants.
//
// Class strings are FULL literals throughout — the style table compiles at
// build time and template-interpolated fragments are a compile error, so the
// bevel recipes repeat verbatim instead of riding shared constants.

import { Image, Text, View } from "@pocketjs/framework/components";
import { FONT, FONT_B, FONT_XL } from "./theme.ts";
import type { CaptionButton } from "./wm.ts";
import type { DeskIcon, Popup, TaskEntry, WinCtl } from "./state.ts";

/** W95FA text. Slots 19/20/21 ride the style prop — the class table never
 *  sees them (baked per-app via pak.json, docs in gen-assets.ts). Text rides
 *  the `t` prop; `cls` replaces the class attr so nothing falls through to
 *  a user component's attrs. */
export function T98(props: { t: string; cls?: string; bold?: boolean; xl?: boolean }) {
  return (
    <Text
      class={props.cls ?? "text-[#000000]"}
      style={{ fontSlot: props.xl ? FONT_XL : props.bold ? FONT_B : FONT }}
    >
      {props.t}
    </Text>
  );
}

const BTN_ICON: Record<CaptionButton, string> = {
  min: "icons/cap-min.svg",
  max: "icons/cap-max.svg",
  close: "icons/cap-close.svg",
};

/** Caption controls, flush right and flush against each other (wm.ts
 *  captionButtonXs mirrors this row). Press feedback inverts the bevel and
 *  nudges the glyph one px — app.tsx drives win.pressedBtn off the raw
 *  pointer stream. */
export function CaptionButtons(props: { win: WinCtl }) {
  const w = props.win;
  return (
    <View class="flex-row items-center">
      {w.buttons.map((btn) => (
        <View
          class={
            w.pressedBtn.value === btn
              ? "w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
              : "w-[16] h-[14] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
          }
        >
          <Image
            class={w.pressedBtn.value === btn ? "w-[8] h-[8] ml-[1] mt-[1]" : "w-[8] h-[8]"}
            src={btn === "max" && w.maximized.value ? "icons/cap-restore.svg" : BTN_ICON[btn]}
          />
        </View>
      ))}
    </View>
  );
}

/** The taskbar: the Start button (PocketJS favicon mark, gen-icons
 *  start-logo), one button per window, the sunken clock tray. */
export function Taskbar(props: {
  entries: TaskEntry[];
  activeId: number;
  startOpen: boolean;
  clock: string;
  buttonW: number;
}) {
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
        <Image class="w-[16] h-[16]" src="icons/start-logo.svg" />
        <T98 bold t="Start" />
      </View>
      <View class="w-[1] h-[22] bevel-[#808080,#ffffff]" />
      <View class="flex-1 flex-row items-center gap-[3] overflow-hidden">
        {props.entries.map((entry) => (
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
              <T98 bold={entry.id === props.activeId} t={entry.title} />
            </View>
          </View>
        ))}
      </View>
      <View class="h-[22] flex-row items-center px-[8] bevel-[#808080,#ffffff]">
        <T98 t={props.clock} />
      </View>
    </View>
  );
}

/** Generic popup menu panel (context menus, dropdowns, start flyouts). */
export function PopupPanel(props: { popup: Popup; hover: number }) {
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
      {props.popup.items.map((item, i) =>
        item.sep ? (
          <View class="h-[8] flex-col justify-center px-[1]">
            <View class="h-[1] bg-[#808080]" />
            <View class="h-[1] bg-[#ffffff]" />
          </View>
        ) : (
          <View
            class={
              props.hover === i && !item.disabled
                ? "h-[18] flex-row items-center gap-[5] pl-[4] pr-[8] bg-[#000080]"
                : "h-[18] flex-row items-center gap-[5] pl-[4] pr-[8]"
            }
          >
            {item.icon ? (
              <Image class="w-[16] h-[16]" src={item.icon} />
            ) : (
              <View class="w-[16] h-[16]" />
            )}
            <View class="flex-1 flex-row">
              <T98
                cls={
                  item.disabled
                    ? "text-[#808080]"
                    : props.hover === i
                      ? "text-[#ffffff]"
                      : "text-[#000000]"
                }
                t={item.label}
              />
            </View>
            {item.shortcut ? (
              <T98
                cls={
                  item.disabled
                    ? "text-[#808080]"
                    : props.hover === i
                      ? "text-[#ffffff]"
                      : "text-[#000000]"
                }
                t={item.shortcut}
              />
            ) : null}
            {item.sub ? <Image class="w-[8] h-[8] ml-[2]" src="icons/menu-arrow.svg" /> : null}
          </View>
        ),
      )}
    </View>
  );
}

/** The Start menu: a plain navy gradient banner strip + 26px rows (flyouts
 *  render as PopupPanels). */
export function StartMenu(props: {
  x: number;
  y: number;
  h: number;
  items: Popup["items"];
  hover: number;
}) {
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
      <View class="w-[24] h-full bg-gradient-to-t from-[#000080] to-[#1084d0]" />
      <View class="flex-1 flex-col">
        {props.items.map((item, i) =>
          item.sep ? (
            <View class="h-[8] flex-col justify-center px-[2]">
              <View class="h-[1] bg-[#808080]" />
              <View class="h-[1] bg-[#ffffff]" />
            </View>
          ) : (
            <View
              class={
                props.hover === i && !item.disabled
                  ? "h-[26] flex-row items-center gap-[6] pl-[6] pr-[6] bg-[#000080]"
                  : "h-[26] flex-row items-center gap-[6] pl-[6] pr-[6]"
              }
            >
              <Image class="w-[16] h-[16]" src={item.icon ?? ""} />
              <View class="flex-1 flex-row">
                <T98
                  cls={
                    item.disabled
                      ? "text-[#808080]"
                      : props.hover === i
                        ? "text-[#ffffff]"
                        : "text-[#000000]"
                  }
                  t={item.label}
                />
              </View>
              {item.sub ? <Image class="w-[8] h-[8]" src="icons/menu-arrow.svg" /> : null}
            </View>
          ),
        )}
      </View>
    </View>
  );
}

/** Desktop icons: a left column of 32px art + label, teal behind. */
export function DesktopIcons(props: { icons: DeskIcon[]; selected: number }) {
  return (
    <View class="absolute left-0 top-0 flex-col gap-[10] p-[8]">
      {props.icons.map((icon, i) => (
        <View class="w-[74] flex-col items-center gap-[3]">
          <Image class="w-[32] h-[32]" src={icon.icon} />
          <View class={props.selected === i ? "bg-[#000080] px-[2]" : "px-[2]"}>
            <T98 cls="text-[#ffffff]" t={icon.label} />
          </View>
        </View>
      ))}
    </View>
  );
}
