// @title psp-ui: Hero
import Hero from "./hero.tsx";
import { heroFrame } from "./hero.tsx";
import { mount } from "../src/index.ts";

mount(() => <Hero />, { beforeFrame: heroFrame });
