import type { AnimationTheme } from "../compiler/animation.ts";

export type PocketFramework = "solid" | "vue-vapor";

export interface PocketConfig {
  /**
   * JSX/runtime framework for application sources. Solid is the default for
   * existing apps; Vue Vapor can be selected here or with --framework.
   */
  framework?: PocketFramework;
  /**
   * Tailwind-config-shaped theme extensions. `keyframes` + `animation` feed
   * the build-time animation baker (framework/compiler/animation.ts): `animate-<name>`
   * class utilities resolve against these, and every referenced animation is
   * baked into the styles.bin ANIM TABLE as fixed-dt segment timelines.
   * An app directory may carry its own pocket.config.ts, which the build
   * prefers over the repo root one.
   */
  theme?: AnimationTheme;
}

export function definePocketConfig(config: PocketConfig): PocketConfig {
  return config;
}
