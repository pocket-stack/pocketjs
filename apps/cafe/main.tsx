// @title PocketJS: Café
import Cafe from "./app.tsx";
import { installCafeBackend } from "./backend.ts";
import { mount } from "@pocketjs/framework";

installCafeBackend();
mount(() => <Cafe />);
