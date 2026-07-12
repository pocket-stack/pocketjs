// @title PocketJS: Nightbloom
import Nightbloom from "./app.tsx";
import { installAugury } from "./backend.ts";
import { installSfx } from "./sfx.ts";
import { mount } from "@pocketjs/framework";

installAugury();
installSfx(); // no-op on hosts without an audio device
mount(() => <Nightbloom />);
