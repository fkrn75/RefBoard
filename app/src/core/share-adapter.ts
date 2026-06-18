// 클라우드 공유 추상 인터페이스 — "보드를 업로드하면 링크가 나오고, 그 링크로 다시 복원된다"는
// 계약을 한 곳에 고정한다. 실제 백엔드(Supabase 등)는 이 인터페이스를 그대로 구현해 끼우면 되고,
// 지금은 외부 키 없이 동작·검증할 수 있는 LocalShareAdapter(localStorage 목업)를 제공한다.
//
// 역할 분담:
//   - share-export.ts = 서버리스 1순위(자기완결 HTML 파일 하나로 어디서나 열기).
//   - share-adapter.ts = "짧은 링크로 공유" 2순위(업로드 → URL → 모바일/뷰어에서 load로 복원).
//   두 경로 모두 board.ts의 BoardState/serialize/deserialize를 단일 진실로 공유한다.

import { serialize, deserialize, genId, type BoardState } from './board'

/**
 * 클라우드 공유 어댑터 계약.
 * 백엔드가 무엇이든(localStorage 목업·Supabase·자체 서버) 이 4개 메서드만 만족하면
 * 상위(공유 UI/딥링크 라우팅)는 구현을 몰라도 된다.
 */
export interface ShareAdapter {
  // 보드를 업로드하고 식별자와 공유 URL을 돌려준다.
  upload(board: BoardState): Promise<{ id: string; url: string }>
  // 식별자로부터 공유 URL을 합성한다(업로드 없이 링크만 다시 만들 때).
  getShareUrl(id: string): string
  // 식별자로 보드를 복원한다. 없으면 null(만료/오타/미존재).
  load(id: string): Promise<BoardState | null>
}

// LocalShareAdapter가 localStorage에 쓰는 키 접두사. 한 항목 = 한 보드의 직렬화 JSON.
const STORAGE_PREFIX = 'refboard:share:'

// 공유 딥링크 형식. 해시 라우팅(#/b/<id>)이라 정적 호스팅·파일 경로에서도 안전하게 동작한다.
// (Supabase 어댑터도 동일 형식을 유지하면 라우팅 코드가 백엔드와 무관해진다.)
function buildShareHash(id: string): string {
  return `#/b/${id}`
}

/**
 * LocalShareAdapter — 외부 키 없이 동작하는 목업 어댑터.
 * 보드를 localStorage에 직렬화 저장하고 '#/b/<shortId>' 형태의 같은-출처 URL을 돌려준다.
 * 같은 브라우저 안에서 업로드↔복원 왕복을 검증하는 용도이며, 기기 간 공유는 하지 못한다
 * (그건 Supabase 등 실제 백엔드 어댑터의 몫 — 동일 인터페이스로 후속 구현, 키 필요).
 *
 * 주의: localStorage는 동기 API라 Promise로 감싸 인터페이스(async)와 형태를 맞춘다.
 * SSR/비브라우저 환경 대비로 storage 접근은 가드한다.
 */
export class LocalShareAdapter implements ShareAdapter {
  // 같은-출처 URL의 베이스(origin + pathname). 생성 시 캡처해 두고 getShareUrl에서 사용한다.
  // 브라우저가 아니면(테스트 등) 빈 베이스로 두어 해시만 반환한다.
  private readonly baseUrl: string

  constructor(baseUrl?: string) {
    if (baseUrl !== undefined) {
      this.baseUrl = baseUrl
    } else if (typeof location !== 'undefined') {
      // 쿼리/해시를 제외한 현재 문서 위치를 베이스로 삼는다.
      this.baseUrl = location.origin + location.pathname
    } else {
      this.baseUrl = ''
    }
  }

  // localStorage 핸들을 안전하게 얻는다(비브라우저·접근 차단 시 null).
  private store(): Storage | null {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null
    } catch {
      // 일부 환경(파일 프로토콜·프라이버시 모드)은 접근 시 throw → null로 폴백.
      return null
    }
  }

  async upload(board: BoardState): Promise<{ id: string; url: string }> {
    // 짧은 식별자 생성(board.ts genId 재사용 — 포맷 일관성). 충돌 가능성은 무시 가능 수준.
    const id = genId()
    const s = this.store()
    if (!s) {
      throw new Error('이 환경에서는 localStorage를 사용할 수 없어 로컬 공유를 저장하지 못했습니다.')
    }
    // board.ts의 serialize로 직렬화(저장 포맷 단일 진실). 쿼터 초과는 친절한 메시지로 변환(bug-io P2).
    try {
      s.setItem(STORAGE_PREFIX + id, serialize(board))
    } catch {
      throw new Error('용량 초과로 로컬 공유를 저장하지 못했습니다(이미지가 많은 보드는 .refb 저장을 권장).')
    }
    return { id, url: this.getShareUrl(id) }
  }

  getShareUrl(id: string): string {
    return this.baseUrl + buildShareHash(id)
  }

  async load(id: string): Promise<BoardState | null> {
    const s = this.store()
    if (!s) return null
    const json = s.getItem(STORAGE_PREFIX + id)
    if (json === null) return null // 미존재/만료/오타 → null(throw 아님, 호출측이 "없음"을 분기).
    try {
      return deserialize(json)
    } catch {
      // 저장 데이터 손상 → null로 간주(앱이 죽지 않도록).
      return null
    }
  }
}

// Supabase 어댑터는 동일 ShareAdapter 인터페이스로 후속 구현한다(키 필요).
// upload = Storage/DB insert → 공개 id 반환, getShareUrl = 배포 도메인 + '#/b/<id>',
// load = id로 select 후 deserialize. 상위 라우팅/공유 UI는 무수정으로 교체 가능.
