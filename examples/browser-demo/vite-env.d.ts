/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FLYTE_ENDPOINT: string
  readonly VITE_FLYTE_ORG: string
  readonly VITE_FLYTE_PROJECT: string
  readonly VITE_FLYTE_DOMAIN: string
  readonly VITE_FLYTE_TASK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
