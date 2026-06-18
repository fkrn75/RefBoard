// 최근 파일 목록 + 마지막 세션 보존 모듈 (RefBoard Phase 3).
//
// 설계 원칙:
//  - 모두 localStorage(동기·문자열 전용) 기반. 최근 파일 메타데이터는 작아서 용량 한계가
//    문제되지 않는다. "마지막 세션"은 보드 전체이므로 클 수 있으나(임베드 이미지 포함),
//    IndexedDB 의존을 끌어들이지 않기 위해 동일 계층을 쓴다 — 용량 초과 시 조용히 실패하고
//    다음 시작에서 빈 보드로 떨어진다(아래 setLastSession 주석).
//  - board.ts(serialize/deserialize)가 직렬화 SSOT. BoardState 객체를 직접 보관하지 않고
//    serialize된 문자열만 저장해 결합도를 낮추고 round-trip 안전성을 보장한다.
//  - "마지막 세션 자동 열기"의 실제 배선(시작 시 getLastSession→씬 적용)은 main.ts 담당.

import { serialize, deserialize, type BoardState } from './board'

// ---- 저장 키 ----
const RECENT_KEY = 'refboard.recent' // 최근 파일 목록(JSON 배열)
const LAST_SESSION_KEY = 'refboard.lastSession' // 마지막 세션 보드(serialize 문자열)

// 최근 목록 기본 최대 개수. setMaxRecent로 변경 가능.
const DEFAULT_MAX_RECENT = 10
let maxRecent = DEFAULT_MAX_RECENT

// 최근 파일 1건. name을 식별자로 삼아(같은 이름=같은 항목) 중복을 제거한다.
export interface RecentEntry {
  name: string // 파일명(.refb). 목록 내 고유 식별자 역할
  ts: number // 마지막 열기/저장 시각(epoch ms) — 최신순 정렬·"n분 전" 표기용
  size?: number // 파일 크기(byte, 선택) — 목록에 부가 표기용
}

// 최근 목록 최대 개수를 변경한다(양의 정수만 허용, 그 외는 무시).
// 이미 저장된 목록은 다음 addRecent 시 새 한도로 잘린다.
export function setMaxRecent(n: number): void {
  if (typeof n === 'number' && Number.isInteger(n) && n > 0) maxRecent = n
}

// 현재 최근 목록 최대 개수.
export function getMaxRecent(): number {
  return maxRecent
}

// 최근 파일을 목록에 추가한다.
//  - 같은 name이 이미 있으면 제거 후 맨 앞에 다시 넣어 "최신"으로 끌어올린다(중복 1건 유지).
//  - 최대 개수를 넘으면 오래된 항목부터 잘라낸다.
//  - ts는 호출측이 준 값을 그대로 신뢰한다(보통 Date.now()).
export function addRecent(entry: RecentEntry): void {
  const list = getRecent().filter((e) => e.name !== entry.name)
  list.unshift({ name: entry.name, ts: entry.ts, size: entry.size })
  writeRecent(list.slice(0, maxRecent))
}

// 최근 목록을 최신순(ts 내림차순)으로 반환한다. 저장본이 없거나 손상되면 빈 배열.
export function getRecent(): RecentEntry[] {
  const raw = safeGet(RECENT_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // 손상/구버전 방어: 각 원소를 RecentEntry로 좁혀 유효한 것만 남긴다.
    const list = parsed.filter(isRecentEntry)
    // 저장 시 정렬돼 있지만, 외부 변조·구버전 대비로 읽을 때도 최신순을 보장한다.
    return list.sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}

// 특정 name의 최근 항목을 제거한다(없으면 무시).
export function removeRecent(name: string): void {
  const list = getRecent().filter((e) => e.name !== name)
  writeRecent(list)
}

// 최근 목록 전체를 비운다.
export function clearRecent(): void {
  safeRemove(RECENT_KEY)
}

// ---- 마지막 세션(시작 시 복원용) ----

// 현재 보드를 "마지막 세션"으로 저장한다(다음 실행에서 이어 열기용).
//  - serialize된 문자열로 보관. 임베드 이미지가 많으면 localStorage 용량(보통 5~10MB)을
//    넘을 수 있고, 그 경우 QuotaExceededError를 흡수하고 저장하지 않는다(조용히 실패 →
//    다음 시작은 빈 보드). 크래시 복구는 autosave.ts(IndexedDB)가 별도로 담당한다.
export function setLastSession(state: BoardState): void {
  try {
    safeSet(LAST_SESSION_KEY, serialize(state))
  } catch {
    // 용량 초과·직렬화 실패 모두 무시(마지막 세션은 "있으면 좋은" 편의 기능).
  }
}

// 마지막 세션 보드를 복원해 반환한다(없거나 손상되면 null).
export function getLastSession(): BoardState | null {
  const raw = safeGet(LAST_SESSION_KEY)
  if (!raw) return null
  try {
    return deserialize(raw)
  } catch {
    return null
  }
}

// 마지막 세션 저장본을 비운다(예: 사용자가 "새 보드"로 시작).
export function clearLastSession(): void {
  safeRemove(LAST_SESSION_KEY)
}

// ---- 내부 헬퍼 ----

// 임의 값이 RecentEntry 형태인지 좁혀서 확인.
function isRecentEntry(v: unknown): v is RecentEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.name !== 'string' || typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return false
  if (o.size !== undefined && typeof o.size !== 'number') return false
  return true
}

// 최근 목록을 직렬화해 저장(용량/접근 실패는 흡수).
function writeRecent(list: RecentEntry[]): void {
  try {
    safeSet(RECENT_KEY, JSON.stringify(list))
  } catch {
    // 메타데이터는 작아 사실상 실패하지 않지만, 접근 차단 환경 방어로 흡수한다.
  }
}

// localStorage 접근 래퍼 — 비가용(SSR·프라이빗 모드 차단 등) 환경을 방어한다.
function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

// 값 저장. 호출측이 QuotaExceededError를 구분해 처리할 수 있도록 여기서는 다시 던진다.
function safeSet(key: string, value: string): void {
  const ls = globalThis.localStorage
  if (!ls) throw new Error('localStorage 사용 불가')
  ls.setItem(key, value)
}

function safeRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // 접근 차단 환경에서도 throw가 새어 나가지 않게 흡수.
  }
}
