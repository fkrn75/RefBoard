/// <reference types="vite/client" />

// .env 의 VITE_* 환경변수 타입(Supabase 연결 키). 없을 수 있으므로 optional.
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
