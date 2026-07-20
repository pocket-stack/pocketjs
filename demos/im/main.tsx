// @title PocketJS: Talk
import Talk from "./app.tsx";
import { installTalkBackend } from "./backend.ts";
import { mount } from "@pocketjs/framework";

installTalkBackend();
mount(() => <Talk />);
