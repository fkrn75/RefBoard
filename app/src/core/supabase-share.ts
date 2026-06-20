// SupabaseShareAdapter — 실제 클라우드 공유 백엔드(Supabase Auth + Postgres RLS + 비공개 Storage).
// ShareAdapter 인터페이스를 그대로 구현하므로, 상위(공유 UI·뷰어 라우팅)는 LocalShareAdapter와 교체만으로 동작한다.
//
// 설계: docs/share-backend-design.md (v2, P1 7건 반영). 핵심 반영점:
//  - 고엔트로피 board_id(crypto.randomUUID, P1#2)
//  - 업로드: insert(status='uploading') → Storage 분리 업로드(키 치환·data URL 제거) → status='ready' (P1#5)
//  - 실패 시 보상삭제(boards 행 + Storage best-effort) (P1#5)
//  - orig 기본 미저장: 라이트박스도 medium 재사용(orig 키 = medium 키) (P1#3)
//  - load: RLS select(0행=권한없음) → medium 7일 서명URL 치환 (P1#6)
//  - assertNoDataUrls: 업로드 후 jsonb에 data URL 잔존 시 저장 중단 (P1#4)

import type { BoardState } from './board'
import { attachSrcSets } from './srcset'
import { getSupabase, hasSupabase, BOARDS_BUCKET } from './supabase'
import { LocalShareAdapter, type LoadResult, type ShareAdapter, type ShareUser, type UploadOptions } from './share-adapter'
import type { SupabaseClient } from '@supabase/supabase-js'

// 서명 URL 수명: medium은 장수명(7일)+캐시로 egress 절감(P1#6). orig는 medium을 재사용하므로 동일.
const SIGNED_URL_TTL = 60 * 60 * 24 * 7 // 7일(초)

export class SupabaseShareAdapter implements ShareAdapter {
  // deployUrl = 뷰어 베이스(예: https://도메인/viewer.html). getShareUrl이 여기에 #/b/<id>를 붙인다.
  constructor(private readonly deployUrl: string) {}

  private sb(): SupabaseClient {
    const c = getSupabase()
    if (!c) throw new Error('Supabase가 설정되지 않았습니다(.env의 VITE_SUPABASE_* 확인).')
    return c
  }

  getShareUrl(id: string): string {
    return `${this.deployUrl}#/b/${id}`
  }

  // ---- 인증 ----
  async getCurrentUser(): Promise<ShareUser | null> {
    const { data } = await this.sb().auth.getUser()
    const email = data.user?.email
    return email ? { email } : null
  }

  async signIn(): Promise<void> {
    // 구글 OAuth. 복귀용 해시(#/b/<id>)를 저장해 콜백 후 복원한다(설계 10절).
    try {
      localStorage.setItem('refboard:return-hash', location.hash)
    } catch {
      /* 저장 불가 환경은 무시 */
    }
    const { error } = await this.sb().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    })
    if (error) throw error
    // 성공 시 브라우저가 구글로 리다이렉트되므로 이후 코드는 실행되지 않는다.
  }

  async signInWithEmail(email: string): Promise<void> {
    // 매직링크(이메일). 구글 계정이 없는 뷰어용 폴백.
    const { error } = await this.sb().auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: location.href },
    })
    if (error) throw error
  }

  async signOut(): Promise<void> {
    await this.sb().auth.signOut()
  }

  async setAllowlist(id: string, emails: string[]): Promise<void> {
    const rows = emails
      .map((e) => ({ board_id: id, email: e.trim().toLowerCase() }))
      .filter((r) => r.email.length > 0)
    if (rows.length === 0) return
    const { error } = await this.sb().from('board_allowlist').upsert(rows)
    if (error) throw error
  }

  // ---- 업로드(작성자) ----
  async upload(board: BoardState, opts?: UploadOptions): Promise<{ id: string; url: string }> {
    const sb = this.sb()
    const { data: userData } = await sb.auth.getUser()
    const owner = userData.user?.id
    if (!owner) throw new Error('로그인이 필요합니다.')

    const id = highEntropyId() // 고엔트로피 board_id(P1#2)
    const expiresAt = opts?.expiresAt ? opts.expiresAt.toISOString() : null

    // P1#5: 먼저 행을 'uploading'으로 삽입(고아 방지 기준점).
    const ins = await sb.from('boards').insert({
      id,
      owner,
      title: board.board?.title ?? '',
      data: {},
      status: 'uploading',
      is_public: !!opts?.isPublic,
      expires_at: expiresAt,
    })
    if (ins.error) throw ins.error

    try {
      // attachSrcSets: 일반 이미지에 srcs(data URL) 생성 + 원본 src 비움(P1#4 코드 반영).
      const shared = await attachSrcSets(board, { onProgress: opts?.onProgress })

      for (const it of shared.items) {
        if (it.type !== 'image') continue
        if (it.srcs) {
          // 일반 이미지: thumb/medium만 업로드(orig 기본 미저장, P1#3).
          const thumbKey = `${id}/${it.id}/thumb.webp`
          const medKey = `${id}/${it.id}/medium.webp`
          await this.put(thumbKey, it.srcs.thumb)
          await this.put(medKey, it.srcs.medium)
          // orig 키 = medium 키(라이트박스도 medium 재사용). 고화질 옵트인은 후속.
          it.srcs = { thumb: thumbKey, medium: medKey, orig: medKey }
          it.src = '' // attachSrcSets가 이미 비웠지만 방어적으로 한 번 더.
        } else if (it.src && it.src.startsWith('data:')) {
          // crop·GIF(srcs 없음): 원본을 업로드하고 키로 치환(경량본 생성은 후속 TODO).
          const ext = guessExt(it.src)
          const key = `${id}/${it.id}/src.${ext}`
          await this.put(key, it.src)
          it.src = key
        }
      }

      // P1#4 가드: 업로드 후에도 data URL이 남으면 DB 폭증 → 저장 중단.
      assertNoDataUrls(shared)

      const upd = await sb.from('boards').update({ data: shared, status: 'ready' }).eq('id', id)
      if (upd.error) throw upd.error

      if (opts?.allowEmails?.length) await this.setAllowlist(id, opts.allowEmails)

      return { id, url: this.getShareUrl(id) }
    } catch (e) {
      // P1#5: 보상삭제 — boards 행 제거(Storage는 best-effort, 나머지는 고아 GC가 정리).
      try {
        await this.removeFolder(id)
      } catch {
        /* best-effort */
      }
      try {
        await sb.from('boards').delete().eq('id', id)
      } catch {
        /* best-effort */
      }
      throw e
    }
  }

  // ---- 로드(뷰어) ----
  async load(id: string): Promise<LoadResult> {
    const sb = this.sb()
    const { data, error } = await sb
      .from('boards')
      .select('data,status,expires_at')
      .eq('id', id)
      .maybeSingle()

    if (error) {
      // RLS 거부 등은 보통 0행(error 없음)으로 오지만, 예외 시 권한 문제로 간주.
      const user = await this.getCurrentUser()
      return { ok: false, reason: user ? 'forbidden' : 'auth-required' }
    }
    if (!data) {
      // 0행 = 미존재 또는 RLS 거부(미허가/만료). 로그인 여부로 사유를 가른다.
      const user = await this.getCurrentUser()
      return { ok: false, reason: user ? 'forbidden' : 'auth-required' }
    }
    if (data.status !== 'ready') return { ok: false, reason: 'not-found' } // 업로드 미완

    const board = data.data as BoardState
    await this.signUrls(board) // Storage 키 → 서명 URL
    return { ok: true, board }
  }

  // ---- 내부 헬퍼 ----

  // data URL을 Blob으로 변환해 Storage에 업로드(같은 키면 덮어쓰기).
  private async put(key: string, dataUrl: string): Promise<void> {
    const blob = dataUrlToBlob(dataUrl)
    const { error } = await this.sb()
      .storage.from(BOARDS_BUCKET)
      .upload(key, blob, { contentType: blob.type || 'application/octet-stream', upsert: true })
    if (error) throw error
  }

  // 보드 폴더의 모든 객체를 삭제(보상삭제용 best-effort). Storage list는 한 레벨이라 itemId 하위까지 순회.
  private async removeFolder(id: string): Promise<void> {
    const sb = this.sb()
    const { data: dirs } = await sb.storage.from(BOARDS_BUCKET).list(id, { limit: 1000 })
    const paths: string[] = []
    for (const d of dirs ?? []) {
      const { data: files } = await sb.storage.from(BOARDS_BUCKET).list(`${id}/${d.name}`, { limit: 1000 })
      for (const f of files ?? []) paths.push(`${id}/${d.name}/${f.name}`)
    }
    if (paths.length) await sb.storage.from(BOARDS_BUCKET).remove(paths)
  }

  // 보드 안의 Storage 키들을 한 번에 서명 URL로 치환(뷰어가 그대로 문자열 src로 사용).
  private async signUrls(board: BoardState): Promise<void> {
    const keys = new Set<string>()
    const isKey = (s: string) => !!s && !s.startsWith('data:') && !/^https?:/i.test(s) && !s.startsWith('blob:')
    for (const it of board.items) {
      if (it.type !== 'image') continue
      if (it.srcs) {
        for (const k of [it.srcs.thumb, it.srcs.medium, it.srcs.orig]) if (isKey(k)) keys.add(k)
      } else if (it.src && isKey(it.src)) {
        keys.add(it.src)
      }
    }
    if (keys.size === 0) return

    const list = [...keys]
    const { data } = await this.sb().storage.from(BOARDS_BUCKET).createSignedUrls(list, SIGNED_URL_TTL)
    const map = new Map<string, string>()
    for (const e of data ?? []) if (e.path && e.signedUrl) map.set(e.path, e.signedUrl)

    for (const it of board.items) {
      if (it.type !== 'image') continue
      if (it.srcs) {
        it.srcs = {
          thumb: map.get(it.srcs.thumb) ?? it.srcs.thumb,
          medium: map.get(it.srcs.medium) ?? it.srcs.medium,
          orig: map.get(it.srcs.orig) ?? it.srcs.orig,
        }
      } else if (it.src) {
        it.src = map.get(it.src) ?? it.src
      }
    }
  }
}

// hasSupabase()면 실제 어댑터, 아니면 목업(LocalShareAdapter). 상위는 이 팩토리만 호출하면 된다.
export function getShareAdapter(deployUrl: string): ShareAdapter {
  return hasSupabase() ? new SupabaseShareAdapter(deployUrl) : new LocalShareAdapter(deployUrl)
}

// ---- 모듈 헬퍼 ----

// 고엔트로피 ID(128bit) — 공개 enumerate 공격 방어(P1#2). crypto 미지원 환경은 폴백.
function highEntropyId(): string {
  const c = globalThis.crypto
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '')
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('').slice(0, 32)
}

// data URL → Blob.
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const body = dataUrl.slice(comma + 1)
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  if (/;base64/i.test(head)) {
    const bin = atob(body)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Blob([arr], { type: mime })
  }
  return new Blob([decodeURIComponent(body)], { type: mime })
}

// data URL의 이미지 확장자 추정(키 파일명용).
function guessExt(dataUrl: string): string {
  const t = (/data:image\/([a-z0-9]+)/i.exec(dataUrl)?.[1] ?? 'bin').toLowerCase()
  return t === 'jpeg' ? 'jpg' : t
}

// 업로드 후에도 board JSON에 원본 data URL이 남아 있으면 throw(P1#4: DB 폭증·egress 방지).
function assertNoDataUrls(board: BoardState): void {
  for (const it of board.items) {
    if (it.type !== 'image') continue
    const vals = it.srcs ? [it.srcs.thumb, it.srcs.medium, it.srcs.orig] : []
    if (it.src) vals.push(it.src)
    if (vals.some((v) => typeof v === 'string' && v.startsWith('data:')))
      throw new Error(`업로드 후에도 원본 데이터가 남았습니다(item ${it.id}). 저장을 중단합니다.`)
  }
}
