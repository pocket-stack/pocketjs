// @title PocketJS: Cursor
import CursorDemo from "./app.tsx";
import { mount } from "@pocketjs/framework";
import { enableCursor } from "@pocketjs/framework/input";

// Opt in to the virtual cursor (input.cursor). Safe before mount — the
// sprite uploads lazily on the first frame. dpadSpeed keeps the golden tape
// button-only (1 px/frame); the nub steers at the default 240 px/s.
enableCursor({ dpadSpeed: 60 });

mount(() => <CursorDemo />);
