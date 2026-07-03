// @title psp-ui: Hero
import Hero, { heroFrame } from "./app.tsx";
import { mount } from "psp-ui";

mount(() => <Hero />, { beforeFrame: heroFrame });
