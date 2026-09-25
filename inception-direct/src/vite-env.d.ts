/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Override Inception's API origin (the tests point this at a local simulator). */
  readonly VITE_INCEPTION_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
