// @title NS Engine
import { mount } from "@pocketjs/framework/solid";
import App from "./app.tsx";
import { installSvcEffectDriver } from "./channel.ts";

installSvcEffectDriver();
mount(() => <App />);
