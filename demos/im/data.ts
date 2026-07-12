// demos/im/data.ts — Pocket Talk's world: contacts, corpora, and timestamps.
//
// Everything the "server" will ever say is plain data in this file. Each
// contact has one long canned conversation (`corpus`) that the backend serves
// backwards in pages, and a reply script cycled by how many messages you have
// sent them. Timestamps walk back from a fixed base through an integer-hash
// step function — no Math.random, no Date — so history page N is the same
// bytes in every run, on every host. That is what lets the sim tests and
// pixel goldens hold byte-exact.

// Font-atlas coverage for user-typed text: the build harvests codepoints from
// string literals, and the on-screen keyboard composes strings at runtime —
// spell the full typeable charset (plus the status glyphs) out once.
const CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?'…✓·●○△□×▼↕";
void CHARSET;

export type SendState = "sending" | "sent" | "delivered" | "read";

/** A message as the mock server ships it. */
export interface WireMsg {
  id: string;
  /** "me" or a sender display name. */
  from: string;
  text: string;
  /** Age in days: 0 = today, 1 = yesterday, … */
  day: number;
  /** Minutes since that day's midnight. */
  minute: number;
}

/** A message as the UI holds it — outgoing ones carry a live send state. */
export interface UiMsg extends WireMsg {
  out: boolean;
  state: () => SendState;
}

export interface Contact {
  id: string;
  name: string;
  initial: string;
  online: boolean;
  /** Other member names — present only for group conversations. */
  members?: string[];
  /** Sender-label / avatar accent. */
  accent: string;
  /** Avatar tile — a FULL class literal (the Tailwind subset bakes whole strings). */
  avatarCls: string;
  /** Newest corpus message's stamp, in minutes since TODAY 00:00 (may be
   *  negative — that means a previous day). Also the recency sort key seed. */
  baseMinute: number;
  /** Conversations you have not opened yet start with this badge. */
  unreadSeed: number;
  /** Reply script, cycled by send count. `from` names the group member who
   *  answers; ignored (contact replies) in 1:1 chats. */
  replies: { from: string; text: string }[];
  corpus: { from: string; text: string }[];
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** New messages (sent or pushed) stamp at 10:24 + virtual session time. */
const BASE_MINUTE = 624;

export function stampNow(nowSeconds: number): { day: number; minute: number } {
  // The demo world never crosses virtual midnight (the day-index model counts
  // age, not calendar days) — clamp at 23:59 so a soak run's stamps stay
  // ordered instead of wrapping back to 0:00 under a TODAY chip.
  return { day: 0, minute: Math.min(1439, BASE_MINUTE + Math.floor(nowSeconds / 60)) };
}

/** Deterministic minutes between corpus message k-1 and k: mostly a few
 *  minutes, with an hours-long lull before every 5th message so day
 *  separators actually appear in a seeded thread. */
function step(c: Contact, k: number): number {
  const x = Math.imul(k + c.baseMinute + 7919, 2654435761) >>> 0;
  const base = 4 + (x % 17);
  return k % 5 === 4 ? base + 240 + (x % 200) : base;
}

/** Stamp of the message `back` steps before the contact's newest one. */
function stampBack(c: Contact, back: number): { day: number; minute: number } {
  let m = c.baseMinute;
  for (let k = 1; k <= back; k++) m -= step(c, k);
  const day = m >= 0 ? 0 : Math.ceil(-m / 1440);
  return { day, minute: m + day * 1440 };
}

export function fmtTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${h}:${m < 10 ? "0" + m : m}`;
}

const DAY_LABELS = ["TODAY", "YESTERDAY", "TUESDAY", "MONDAY", "SUNDAY", "SATURDAY", "FRIDAY"];

export function dayLabel(day: number): string {
  return DAY_LABELS[day] ?? "EARLIER";
}

// ---------------------------------------------------------------------------
// History pages — the corpus served backwards, PAGE_LEN messages at a time
// ---------------------------------------------------------------------------

const PAGE_LEN = 14;

/** Highest fetchable page index (page 0 ships with bootstrap). */
export function maxPage(c: Contact): number {
  return Math.ceil(c.corpus.length / PAGE_LEN) - 1;
}

export function historyPage(c: Contact, page: number): WireMsg[] {
  const len = c.corpus.length;
  const end = len - page * PAGE_LEN;
  const start = Math.max(0, end - PAGE_LEN);
  const out: WireMsg[] = [];
  for (let j = start; j < end; j++) {
    const s = stampBack(c, len - 1 - j);
    out.push({ id: `${c.id}-c${j}`, from: c.corpus[j].from, text: c.corpus[j].text, ...s });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ambient traffic — pushes that arrive whether or not you say anything.
// `gap` is virtual seconds after the previous ambient event; the list cycles
// forever, so a long-running session keeps receiving mail.
// ---------------------------------------------------------------------------

interface AmbientEvent {
  gap: number;
  convo: string;
  from: string;
  text: string;
}

export const AMBIENT: AmbientEvent[] = [
  { gap: 7, convo: "nova", from: "NOVA", text: "nightly build 412 finished. 0 failures, 3 warnings." },
  { gap: 6, convo: "lunar", from: "KAI", text: "ok who moved game night to thursday??" },
  { gap: 5, convo: "lunar", from: "RIN", text: "not me. juno?" },
  { gap: 8, convo: "lunar", from: "JUNO", text: "guilty. thursday works for everyone though right :)" },
  { gap: 9, convo: "maya", from: "MAYA CHEN", text: "unrelated but i just found the wildest type foundry, remind me to show you" },
  { gap: 8, convo: "nova", from: "NOVA", text: "reminder. 2 review requests have been waiting on you for 3 days." },
  { gap: 10, convo: "lunar", from: "KAI", text: "thursday confirmed then. bring snacks or bring shame" },
];

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const MAYA: Contact = {
  id: "maya",
  name: "MAYA CHEN",
  initial: "M",
  online: true,
  accent: "#f472b6",
  avatarCls: "w-8 h-8 rounded-full items-center justify-center bg-gradient-to-b from-pink-500 to-pink-700",
  baseMinute: BASE_MINUTE - 2,
  unreadSeed: 0,
  replies: [
    { from: "", text: "ok wait. that is EXACTLY the energy this rewrite needed, keep going" },
    { from: "", text: "hmmm let me sit with that for a bit.\nfirst reaction though. yes?" },
    { from: "", text: "screenshot or it didn't happen :)" },
    { from: "", text: "i owe you a coffee for this whole thread honestly" },
  ],
  corpus: [
    { from: "me", text: "did you end up trying that grid layout idea from friday?" },
    { from: "MAYA CHEN", text: "i did!! and i have OPINIONS" },
    { from: "MAYA CHEN", text: "short version. the grid wins on the reading view but completely falls apart on the compose screen" },
    { from: "me", text: "falls apart how? overflow?" },
    { from: "MAYA CHEN", text: "worse. the sidebar starts eating the content column pixel by pixel until the whole thing looks like a receipt printer" },
    { from: "me", text: "ha. ok that is a very visual bug report" },
    { from: "MAYA CHEN", text: "long version, because you know i cannot help myself.\n\nthe grid assumes every panel has a natural minimum width, but the compose screen has three panels that all believe they are the main character. when the window narrows, nobody yields. the reading view works because the article column is obviously the boss and everything else folds politely behind it.\n\nso my proposal. keep the grid, but give compose an explicit priority order and let the rail collapse to icons first. i mocked it and it feels right at every width i tried." },
    { from: "me", text: "that is the most maya paragraph ever written" },
    { from: "MAYA CHEN", text: "thank you, i take that as a compliment" },
    { from: "me", text: "it was one. ok, priority order sounds right. who tells sam?" },
    { from: "MAYA CHEN", text: "not it" },
    { from: "me", text: "coward" },
    { from: "MAYA CHEN", text: "strategist." },
    { from: "MAYA CHEN", text: "also completely unrelated, look at this specimen page" },
    { from: "MAYA CHEN", text: "type.foundry/specimens/grotesk-mono-live-cut-no4-extended-release" },
    { from: "me", text: "that url is a novel" },
    { from: "MAYA CHEN", text: "the font is worth it. the lowercase g alone" },
    { from: "me", text: "you and lowercase g's. every single time" },
    { from: "MAYA CHEN", text: "a good g is the whole personality of a typeface and i will not be debating this" },
    { from: "me", text: "fine, fine. send the mockups when you have them?" },
    { from: "MAYA CHEN", text: "tonight. i want to fix the icon rail spacing first, it is 2px off and it is all i can see" },
    { from: "me", text: "2px. living dangerously" },
    { from: "MAYA CHEN", text: "you joke but that 2px is load bearing" },
    { from: "me", text: "ok going into a meeting, talk later" },
    { from: "MAYA CHEN", text: "later! sending mockups tonight for real" },
    { from: "MAYA CHEN", text: "ok mockups attached to the doc. three variants.\n\nA is the safe one. B is the one i like. C exists so B looks reasonable in comparison, which is a time honored design tradition." },
    { from: "me", text: "C sacrificed for the greater good. B looks great at first glance" },
    { from: "MAYA CHEN", text: "knew it. ok ping me when you have real feedback" },
  ],
};

const LUNAR: Contact = {
  id: "lunar",
  name: "LUNAR SQUAD",
  initial: "L",
  online: true,
  members: ["RIN", "KAI", "JUNO"],
  accent: "#a78bfa",
  avatarCls: "w-8 h-8 rounded-full items-center justify-center bg-gradient-to-b from-violet-500 to-violet-700",
  baseMinute: BASE_MINUTE - 13,
  unreadSeed: 3,
  replies: [
    { from: "RIN", text: "agreed. motion carried" },
    { from: "KAI", text: "bold words. say that again on thursday when i have the blue shell" },
    { from: "JUNO", text: "adding it to the agenda. yes we have an agenda now, no i will not apologize" },
    { from: "RIN", text: "this chat is 90 percent logistics and 10 percent trash talk and honestly perfect ratio" },
  ],
  corpus: [
    { from: "KAI", text: "results from last night. rin first, me second, juno a distant and heroic third" },
    { from: "JUNO", text: "the word distant was unnecessary" },
    { from: "RIN", text: "the word heroic was generous" },
    { from: "me", text: "i miss ONE night and this is what happens" },
    { from: "KAI", text: "you missed history is what you missed" },
    { from: "RIN", text: "kai got hit by three shells on the last corner. THREE" },
    { from: "KAI", text: "we agreed never to speak of it" },
    { from: "JUNO", text: "we agreed no such thing" },
    { from: "me", text: "three?? on the last corner?? and you still came second?" },
    { from: "KAI", text: "skill" },
    { from: "RIN", text: "the other two players were bots kai" },
    { from: "KAI", text: "trained, professional bots" },
    { from: "me", text: "ok next session i want in. same time?" },
    { from: "JUNO", text: "usual slot. also i am making a spreadsheet for the season standings" },
    { from: "RIN", text: "juno no" },
    { from: "JUNO", text: "juno YES. it has conditional formatting" },
    { from: "KAI", text: "i cannot believe our kart league has better tooling than my actual job" },
    { from: "me", text: "the spreadsheet is a good idea and i am ready to defend that position" },
    { from: "JUNO", text: "thank you. one ally. the revolution begins" },
    { from: "RIN", text: "fine but if there is a pivot table i am leaving the group" },
    { from: "JUNO", text: "define pivot table" },
    { from: "RIN", text: "JUNO" },
    { from: "me", text: "this chat is undefeated" },
    { from: "KAI", text: "ok logistics. controllers at mine, snacks are on whoever lost last week" },
    { from: "JUNO", text: "that is me. i accept my fate. requests?" },
    { from: "me", text: "the spicy ones from the corner shop, obviously" },
    { from: "RIN", text: "seconded" },
    { from: "KAI", text: "motion passes. see everyone thursday" },
  ],
};

const NOVA: Contact = {
  id: "nova",
  name: "NOVA",
  initial: "N",
  online: true,
  accent: "#60a5fa",
  avatarCls: "w-8 h-8 rounded-full items-center justify-center bg-gradient-to-b from-blue-500 to-blue-700",
  baseMinute: BASE_MINUTE - 41,
  unreadSeed: 1,
  replies: [
    { from: "", text: "acknowledged. i have queued that for the next maintenance window." },
    { from: "", text: "noted. current queue depth is 4. you are number 4. i am told this is called honesty." },
    { from: "", text: "done. logs archived and a summary was mailed to the usual place." },
    { from: "", text: "i am a status bot, not a therapist, but for what it is worth. the build believes in you." },
  ],
  corpus: [
    { from: "NOVA", text: "good morning. overnight summary follows." },
    { from: "NOVA", text: "backups completed at 02.14. integrity check passed. 61 percent of quota used." },
    { from: "me", text: "nova what happened to build 409" },
    { from: "NOVA", text: "build 409 failed at the link step. the error suggests a missing symbol. the symbol suggests a missing coffee." },
    { from: "me", text: "did you just make a joke" },
    { from: "NOVA", text: "i am contractually a status bot. any humor is an emergent property and cannot be relied upon." },
    { from: "me", text: "noted. rerun it with the fix from branch flying-shear please" },
    { from: "NOVA", text: "rerunning. estimated time 9 minutes." },
    { from: "NOVA", text: "build 410 succeeded. artifacts published. the missing symbol has been found and given a stern talking to." },
    { from: "me", text: "you are in a mood today" },
    { from: "NOVA", text: "uptime does that. 341 days and counting." },
    { from: "NOVA", text: "scheduled notice. certificate rotation happens this weekend. no action needed from you." },
    { from: "me", text: "thanks nova. keep an eye on the flaky ui test too" },
    { from: "NOVA", text: "watching it. it has failed 3 of the last 40 runs, always on tuesdays. i do not have a theory yet. i do have a grudge." },
  ],
};

const DAD: Contact = {
  id: "dad",
  name: "DAD",
  initial: "D",
  online: false,
  accent: "#fbbf24",
  avatarCls: "w-8 h-8 rounded-full items-center justify-center bg-gradient-to-b from-amber-500 to-amber-700",
  baseMinute: BASE_MINUTE - 1290,
  unreadSeed: 0,
  replies: [
    { from: "", text: "ok" },
    { from: "", text: "ask your mother" },
  ],
  corpus: [
    { from: "DAD", text: "the tomato plants are doing well. photo when your mother shows me how again" },
    { from: "me", text: "ha, tell her hi. how tall are they now?" },
    { from: "DAD", text: "waist high. the secret is talking to them" },
    { from: "me", text: "what do you talk to them about" },
    { from: "DAD", text: "the neighbours mostly" },
    { from: "me", text: "dad" },
    { from: "DAD", text: "they are good listeners" },
    { from: "me", text: "ok i walked into that one. are you two still coming up next month?" },
    { from: "DAD", text: "planning on it. your mother is already deciding what to bring. it is a lot" },
    { from: "me", text: "it is always a lot. that is half the fun" },
    { from: "DAD", text: "i heard that. she says it is ALL the fun" },
    { from: "me", text: "she is right. see you both soon" },
  ],
};

export const CONTACTS: Contact[] = [MAYA, LUNAR, NOVA, DAD];

export function contactById(id: string): Contact {
  const c = CONTACTS.find((c) => c.id === id);
  if (!c) throw new Error(`pocket talk: unknown contact "${id}"`);
  return c;
}
