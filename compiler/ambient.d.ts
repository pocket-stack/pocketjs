// Ambient module declarations for untyped Babel plugins/presets (build-time only).

declare module "@babel/preset-react" {
  const preset: unknown;
  export default preset;
}

declare module "@babel/preset-typescript" {
  const preset: unknown;
  export default preset;
}

declare module "@vue/babel-plugin-jsx" {
  const plugin: unknown;
  export default plugin;
}

declare module "vue-jsx-vapor/api" {
  export function transformVueJsxVapor(
    code: string,
    id: string,
    options?: Record<string, unknown>,
    needSourceMap?: boolean,
    needHmr?: boolean,
    ssr?: boolean,
  ): { code: string; map?: string | null };
}

declare module "@vue-jsx-vapor/runtime/raw" {
  export const propsHelperCode: string;
  export const propsHelperId: string;
  export const ssrHelperCode: string;
  export const ssrHelperId: string;
  export const vaporHelperCode: string;
  export const vaporHelperId: string;
  export const vdomHelperCode: string;
  export const vdomHelperId: string;
}

declare module "babel-preset-solid" {
  const preset: unknown;
  export default preset;
}
