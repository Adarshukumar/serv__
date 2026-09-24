/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Override the Inception origin (tests point this at a local protocol simulator). */
  readonly VITE_INCEPTION_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
