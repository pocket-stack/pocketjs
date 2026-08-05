import Hero from "../hero/app.tsx";

export default function IPhone2GHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2007 touchscreen."
      headline="JSX on ARMv6."
      presentationHz={30}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
