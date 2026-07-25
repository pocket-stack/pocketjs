// @title PocketJS: Launcher
import Launcher from "./app.tsx";
import { mount } from "@pocketjs/framework";
import { REGISTRY } from "./registry.generated.ts";

mount(() => <Launcher registry={REGISTRY} />);
