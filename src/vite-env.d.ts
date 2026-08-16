/// <reference types="vite/client" />

/**
 * Typed environment. Only the variables this app actually reads are declared,
 * so a typo in `import.meta.env.VITE_API_BSE` is a compile error rather than a
 * silent `undefined` that falls back to same-origin at runtime.
 */
interface ImportMetaEnv {
  /** Overrides the API origin. Empty in dev (Vite proxies) and in production
   *  (same-origin behind the reverse proxy). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
