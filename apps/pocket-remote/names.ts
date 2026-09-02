// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/names.ts — what to call a window.
//
// A window's class is a program id, not a name: four terminals all read
// "foot", which told the eye nothing. What distinguishes windows to a person
// is their TITLE — the shell's directory, the file being edited, the page
// being read — so a tile leads with the title and names the program under
// it, and the program's name is prettified out of its class.

/** Classes whose own spelling is not the name a person uses. */
const KNOWN: Record<string, string> = {
  foot: "Foot",
  footclient: "Foot",
  ghostty: "Ghostty",
  alacritty: "Alacritty",
  kitty: "Kitty",
  nvim: "Neovim",
  neovide: "Neovide",
  chromium: "Chromium",
  "google-chrome": "Chrome",
  "brave-browser": "Brave",
  firefox: "Firefox",
  zen: "Zen",
  "microsoft-edge": "Edge",
  code: "VS Code",
  cursor: "Cursor",
  zeditor: "Zed",
  sublime_text: "Sublime Text",
  nautilus: "Files",
  thunar: "Files",
  mpv: "mpv",
  vlc: "VLC",
  spotify: "Spotify",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
  telegramdesktop: "Telegram",
  "1password": "1Password",
  localsend: "LocalSend",
  steam: "Steam",
  obsidian: "Obsidian",
  "org.gnome.nautilus": "Files",
  "com.mitchellh.ghostty": "Ghostty",
};

/**
 * The program's name from a Wayland class: a known spelling, else the last
 * component of a reverse-DNS id, capitalised, with separators turned into
 * spaces. `org.gnome.Nautilus` becomes Files, `dev.zed.Zed` becomes Zed,
 * `qutebrowser` becomes Qutebrowser.
 */
export function appName(windowClass: string): string {
  const raw = windowClass.trim();
  if (!raw) return "window";
  const lower = raw.toLowerCase();
  if (KNOWN[lower]) return KNOWN[lower]!;
  const tail = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : lower;
  if (KNOWN[tail]) return KNOWN[tail]!;
  // Keep the source's own capitalisation for the tail when it has some
  // (`Nautilus`, `Zed`), otherwise capitalise the first letter.
  const sourceTail = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
  const spaced = sourceTail.replace(/[-_]+/g, " ").trim();
  if (!spaced) return raw;
  return /[A-Z]/.test(spaced) ? spaced : spaced[0]!.toUpperCase() + spaced.slice(1);
}

/**
 * What a tile leads with, and what it says underneath: the title first when
 * there is one worth reading, the program's name otherwise. The second line
 * is always the program, so the same window reads the same way whichever
 * line the eye lands on.
 */
export function windowLabels(windowClass: string, title: string): { lead: string; under: string } {
  const name = appName(windowClass);
  const clean = title.trim();
  if (!clean || clean.toLowerCase() === windowClass.trim().toLowerCase() || clean.toLowerCase() === name.toLowerCase()) {
    return { lead: name, under: "" };
  }
  return { lead: clean, under: name };
}
