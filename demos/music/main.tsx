// @title psp-ui: Now Playing
import Music, { musicFrame } from "./app.tsx";
import { mount } from "psp-ui";

mount(() => <Music />, { beforeFrame: musicFrame });
