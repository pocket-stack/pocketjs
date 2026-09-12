import Hero from "../hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

/**
 * First guest on the D211 fbdev host: software raster, QuickJS, on the full
 * 800x480 panel. The large layout is the wide-surface variant Hero already
 * uses on 480x720 logical targets.
 */
export default function D211Hero() {
  return (
    <Hero
      actionLabel="TOUCH THE SCREEN"
      deviceLabel="running on an ArtInChip D211."
      headline="JS on D211."
      largeLayout
      onAction={(count) => reportAppAction("hero_press", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + SOFTWARE"
      spinnerFrameStep={6}
    />
  );
}
