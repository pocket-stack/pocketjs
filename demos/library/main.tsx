// @title psp-ui: Game Library
import Library, { libraryFrame } from "./app.tsx";
import { mount } from "psp-ui";

mount(() => <Library />, { beforeFrame: libraryFrame });
