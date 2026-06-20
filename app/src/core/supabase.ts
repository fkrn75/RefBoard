// Supabase 클라이언트 싱글톤.
// .env 의 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 가 있으면 클라이언트를 만들고,
// 없으면 null 을 반환한다 → 상위에서 LocalShareAdapter(목업)로 자연스럽게 폴백한다.
// anon/publishable 키는 공개돼도 안전(설계 전제: RLS가 유일 방어선). service_role 키는 절대 쓰지 않는다.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

// 비공개 Storage 버킷 이름(셋업 가이드에서 만든 버킷과 일치해야 함).
export const BOARDS_BUCKET = 'boards'

let client: SupabaseClient | null = null

// 키가 설정돼 있으면 true(= 클라우드 공유 백엔드 사용 가능).
export function hasSupabase(): boolean {
  return !!(url && key)
}

// 싱글톤 클라이언트. 키가 없으면 null(목업 폴백).
export function getSupabase(): SupabaseClient | null {
  if (client) return client
  if (!url || !key) return null
  client = createClient(url, key, {
    auth: {
      persistSession: true, // 세션을 localStorage에 저장(재방문 시 자동 로그인)
      autoRefreshToken: true, // 만료 전 토큰 자동 갱신
      detectSessionInUrl: true, // OAuth/매직링크 콜백 토큰을 URL에서 자동 감지·정리
    },
  })
  return client
}
