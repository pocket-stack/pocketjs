// @title Pocket Note
//
// The markdown-widget guest. Build for the desktop widget host with a
// density-2 pak (crisp text on 2x displays):
//
//   bun scripts/build.ts note-main --density=2
//   cargo run -p note-widget                       (pocket3d/examples)
//
// The same bundle boots on any ui host — without the widget host's svc
// channel it renders the sample note read-only (d-pad scrolls).

import Note from "./app.tsx";
import { mount } from "@pocketjs/framework";

mount(() => <Note />);
