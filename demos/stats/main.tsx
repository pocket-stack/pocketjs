// @title psp-ui: Mission Control
import Stats, { statsFrame } from "./app.tsx";
import { mount } from "psp-ui";

mount(() => <Stats />, { beforeFrame: statsFrame });
