export type PocketFramework = "solid" | "vue-vapor";

export interface PocketConfig {
  /**
   * JSX/runtime framework for application sources. Solid is the default for
   * existing apps; Vue Vapor can be selected here or with --framework.
   */
  framework?: PocketFramework;
}

export function definePocketConfig(config: PocketConfig): PocketConfig {
  return config;
}
