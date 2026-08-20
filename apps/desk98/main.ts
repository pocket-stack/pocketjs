// apps/desk98/main.ts — PocketJS 98 entry point. Only the mount lives here:
// the framework-runtime import stays confined to this file (app-check
// typechecks the entry's whole graph; the prelude's globalThis reshaping
// belongs to the runtime, not to app modules).
import { mount } from "@pocketjs/framework/vue-vapor";
import App from "./app.vue";

mount(App);
