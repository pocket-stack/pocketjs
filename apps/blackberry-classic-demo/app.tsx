import Hero from "../hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

/**
 * The same guest bundle mounts under both Classic hosts (the native QNX
 * runtime and the Android Runtime shell); nothing here may depend on which
 * one is running it.
 */
export default function BlackBerryClassicHero() {
  return (
    <Hero
      actionLabel="CLICK OR TAP"
      deviceLabel="running on a BlackBerry Classic."
      headline="JSX on Classic."
      onAction={(count) => reportAppAction("hero_press", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + GLES2"
      spinnerFrameStep={6}
    />
  );
}
