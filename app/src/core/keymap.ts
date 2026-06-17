// 키맵(단축키) 시스템 — RefBoard Phase 4.5.
//
// 설계 원칙:
//  - "액션"과 "키 조합(combo)"을 분리한다. 코드는 액션 id로만 동작을 식별하고,
//    어떤 키가 그 액션을 부르는지는 재바인딩 가능한 테이블(Map<actionId, combo>)이 정한다.
//    덕분에 사용자가 임의로 키를 바꿔도 호출부(main.ts의 keydown)는 matchKey() 한 줄만 본다.
//  - combo는 항상 정규화된 문자열로 다룬다. 수식 키 순서를 'Ctrl+Alt+Shift+Key'로 고정해
//    같은 조합이 표기 차이로 다른 키로 오인되지 않게 한다(예: 'Shift+Ctrl+P' ↔ 'Ctrl+Shift+P').
//  - 영속화는 localStorage('refboard.keymap'). recent.ts와 동일하게 접근 실패/손상을
//    조용히 흡수하고, 저장된 건 "기본값과 다른 바인딩"만 둬서 기본값 변경에 자연히 따라간다.
//  - PixiJS·DOM 어디에도 의존하지 않는 순수 로직 모듈. KeyboardEvent만 입력으로 받는다.

// ---- 타입 ----

// 단축키로 호출 가능한 하나의 명령(동작).
export interface Action {
  id: string // 고유 식별자. 'group.name' 관례(예: 'view.zoomReset')
  label: string // 사람이 읽는 이름(커맨드 팔레트·설정 UI 표기)
  group?: string // 분류(보기/편집/정렬/변형/파일 …). 팔레트 그룹 헤더용
  defaultCombo: string // 기본 키 조합(정규화 표기). 빈 문자열이면 "기본 바인딩 없음"
}

// ---- 정규화: 수식 키 순서 고정 ----

// 표기 통일을 위한 수식 키 고정 순서. parse/format 모두 이 순서를 따른다.
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'] as const

// 메인 키 이름 정규화 표. KeyboardEvent.key/code의 흔들림을 흡수해 표준 표기로 모은다.
// 키는 모두 소문자로 비교한다(아래 normalizeKeyName 참조).
const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  spacebar: 'Space',
  space: 'Space',
  esc: 'Escape',
  escape: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  bracketleft: '[',
  bracketright: ']',
  '[': '[',
  ']': ']',
  plus: '+',
  add: '+',
  '=': '=',
  minus: '-',
  subtract: '-',
}

// 단일 메인 키 이름을 표준 표기로 정규화한다.
//  - 알파벳/숫자 한 글자는 대문자로(예: 'a'→'A', '0'→'0').
//  - 그 외는 KEY_ALIASES 우선, 없으면 첫 글자만 대문자로 다듬는다.
function normalizeKeyName(raw: string): string {
  if (!raw) return ''
  const lower = raw.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  // 한 글자(영문/숫자)는 대문자 표기로 통일.
  if (lower.length === 1) return lower.toUpperCase()
  // 여러 글자 키(예: 'Tab','Home','PageUp')는 첫 글자만 대문자.
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

// KeyboardEvent → 정규화된 combo 문자열('Ctrl+Shift+P' 식).
//  - 수식 키만 눌린 상태(아직 메인 키 없음)면 빈 문자열을 반환한다.
//  - metaKey(맥 Cmd)는 Ctrl과 동일 취급해 크로스플랫폼 표기를 하나로 모은다.
export function formatCombo(e: KeyboardEvent): string {
  const main = mainKeyOf(e)
  if (!main) return '' // 수식 키 단독 입력은 combo가 아님
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(main)
  return parts.join('+')
}

// 이벤트에서 "메인 키"(수식 키를 제외한 실제 키)를 정규화해 뽑는다.
// 수식 키 자체(Control/Alt/Shift/Meta)는 메인 키가 아니므로 빈 문자열.
function mainKeyOf(e: KeyboardEvent): string {
  const key = e.key
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return ''
  // 화살표·괄호 등은 code가 더 안정적이라 우선 시도, 실패 시 key로 폴백.
  if (e.code && (e.code.startsWith('Arrow') || e.code.startsWith('Bracket'))) {
    return normalizeKeyName(e.code)
  }
  return normalizeKeyName(key)
}

// combo 문자열을 정규화한다('shift+ctrl+p' → 'Ctrl+Shift+P').
// 빈/공백 문자열은 빈 문자열(바인딩 없음)로 본다.
export function parseCombo(str: string): string {
  if (!str) return ''
  const tokens = str
    .split('+')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return ''

  let ctrl = false
  let alt = false
  let shift = false
  let main = ''
  for (const tok of tokens) {
    const low = tok.toLowerCase()
    if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'meta' || low === 'win') {
      ctrl = true
    } else if (low === 'alt' || low === 'option' || low === 'opt') {
      alt = true
    } else if (low === 'shift') {
      shift = true
    } else {
      // 마지막 비수식 토큰을 메인 키로 삼는다(여러 개면 뒤엣것 우선).
      main = normalizeKeyName(tok)
    }
  }
  if (!main) return '' // 수식 키만으로는 유효한 combo가 아님
  const parts: string[] = []
  for (const m of MOD_ORDER) {
    if (m === 'Ctrl' && ctrl) parts.push('Ctrl')
    else if (m === 'Alt' && alt) parts.push('Alt')
    else if (m === 'Shift' && shift) parts.push('Shift')
  }
  parts.push(main)
  return parts.join('+')
}

// ---- 액션 레지스트리 ----

// 등록된 액션들(id → Action). registerActions로 채운다.
const actions = new Map<string, Action>()

// 액션들을 레지스트리에 등록한다(같은 id는 덮어쓴다).
// 등록과 동시에 저장된 바인딩을 한 번 로드해 기본값 위에 사용자 변경을 덧입힌다.
export function registerActions(list: Action[]): void {
  for (const a of list) {
    actions.set(a.id, { ...a, defaultCombo: parseCombo(a.defaultCombo) })
  }
  loadBindings()
}

// 등록된 액션 전체를 등록 순서대로 반환한다(팔레트·설정 UI 나열용).
export function getActions(): Action[] {
  return [...actions.values()]
}

// 특정 id의 액션을 반환(없으면 undefined).
export function getAction(id: string): Action | undefined {
  return actions.get(id)
}

// ---- 바인딩 테이블(actionId → combo) ----

// 현재 유효 바인딩. 기본값을 베이스로 사용자 변경분을 덮어쓴 "최종 상태"를 담는다.
const bindings = new Map<string, string>()

const STORAGE_KEY = 'refboard.keymap'

// 한 액션의 현재 바인딩을 반환한다.
//  - 사용자가 바꿨으면 그 값, 아니면 액션의 기본값.
//  - 미등록 id는 빈 문자열.
export function getBinding(id: string): string {
  if (bindings.has(id)) return bindings.get(id) as string
  return actions.get(id)?.defaultCombo ?? ''
}

// 액션의 키를 다시 지정한다(즉시 영속화).
//  - combo를 정규화해 저장. 빈 문자열이면 "바인딩 해제"(어떤 키로도 호출 불가).
//  - 기존에 같은 combo를 쓰던 다른 액션은 건드리지 않는다(충돌 검사는 findConflict로 호출측이 사전 확인).
export function rebind(id: string, combo: string): void {
  if (!actions.has(id)) return
  bindings.set(id, parseCombo(combo))
  saveBindings()
}

// 모든 바인딩을 기본값으로 되돌린다(저장본도 삭제).
export function resetBindings(): void {
  bindings.clear()
  for (const a of actions.values()) bindings.set(a.id, a.defaultCombo)
  safeRemove(STORAGE_KEY)
}

// ---- 매칭/충돌 ----

// 입력 이벤트에 해당하는 액션 id를 찾는다(없으면 null).
// 같은 combo에 여러 액션이 묶여 있으면 등록(나열) 순서상 첫 번째를 돌려준다.
export function matchKey(e: KeyboardEvent): string | null {
  const combo = formatCombo(e)
  if (!combo) return null
  for (const a of actions.values()) {
    if (getBinding(a.id) === combo) return a.id
  }
  return null
}

// 주어진 combo를 이미 쓰는 액션 id를 찾는다(재바인딩 UI의 충돌 경고용).
//  - exceptId는 검사에서 제외(자기 자신과의 충돌은 충돌이 아님).
//  - 빈 combo(=해제)는 충돌 없음으로 본다.
export function findConflict(combo: string, exceptId?: string): string | null {
  const norm = parseCombo(combo)
  if (!norm) return null
  for (const a of actions.values()) {
    if (a.id === exceptId) continue
    if (getBinding(a.id) === norm) return a.id
  }
  return null
}

// ---- 영속화(localStorage) ----

// 저장 포맷: { [actionId]: combo } 중 "기본값과 다른 것"만 보관.
// 기본값과 같은 바인딩까지 저장하면 나중에 기본값을 바꿔도 옛 값이 남아버리므로,
// 변경분(diff)만 저장해 기본값 변경이 자연히 반영되게 한다.
function saveBindings(): void {
  const diff: Record<string, string> = {}
  for (const a of actions.values()) {
    const cur = getBinding(a.id)
    if (cur !== a.defaultCombo) diff[a.id] = cur
  }
  try {
    if (Object.keys(diff).length === 0) safeRemove(STORAGE_KEY)
    else safeSet(STORAGE_KEY, JSON.stringify(diff))
  } catch {
    // 용량 초과·접근 차단은 흡수(키맵은 "있으면 좋은" 편의 설정).
  }
}

// 저장된 변경분을 읽어 현재 바인딩을 재구성한다.
//  - 먼저 모든 등록 액션을 기본값으로 채운 뒤,
//  - 저장본에 있는 항목만 덮어쓴다(미등록 id·잘못된 값은 무시).
function loadBindings(): void {
  bindings.clear()
  for (const a of actions.values()) bindings.set(a.id, a.defaultCombo)

  const raw = safeGet(STORAGE_KEY)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return
    const obj = parsed as Record<string, unknown>
    for (const [id, combo] of Object.entries(obj)) {
      if (!actions.has(id)) continue // 사라진 액션의 옛 바인딩은 버린다
      if (typeof combo !== 'string') continue
      bindings.set(id, parseCombo(combo))
    }
  } catch {
    // 손상된 저장본은 무시하고 기본값 상태로 둔다.
  }
}

// localStorage 접근 래퍼 — recent.ts와 동일 패턴(비가용·차단 환경 방어).
function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}
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

// ---- 기본 액션 카탈로그 ----
//
// main.ts의 window keydown 핸들러(현재 라인 850 부근)에서 실제로 처리하는 단축키를
// 1:1로 추출해 액션화한 것. 통합 시 keydown 본문을 matchKey(e)→switch(actionId)로 바꾸면
// 기존 동작과 그대로 매칭된다(매핑표는 team-lead 통합가이드 참조).
//
// 주의(코드 실제 동작 기준, 기능명세서 부록 A와 일부 차이 있음):
//  - 'view.fitAll'은 명세의 Ctrl+Space와 일치하고, 'view.focusSelected'는 수식 없는 Space.
//  - 저장은 Ctrl+S(명세의 Ctrl+L 열기는 main.ts에선 Ctrl+O로 구현됨 → file.open=Ctrl+O).
//  - 정렬 격자(Ctrl+Alt+N/A/D…)·클립보드 복사/잘라내기 등 "명세엔 있으나 keydown 미구현"
//    항목은 여기 넣지 않았다(존재하지 않는 동작을 액션화하지 않기 위함).
export const DEFAULT_ACTIONS: Action[] = [
  // 보기(View)
  { id: 'view.fitAll', label: '전체 보기', group: '보기', defaultCombo: 'Ctrl+Space' },
  { id: 'view.focusSelected', label: '선택 항목으로 포커스', group: '보기', defaultCombo: 'Space' },
  { id: 'view.zoomReset', label: '줌 100%', group: '보기', defaultCombo: 'Ctrl+0' },
  { id: 'view.toggleMinimap', label: '미니맵 토글', group: '보기', defaultCombo: 'M' },
  { id: 'view.toggleSnap', label: '스냅 토글', group: '보기', defaultCombo: 'N' },
  { id: 'view.toggleGrid', label: '그리드 토글', group: '보기', defaultCombo: 'G' },

  // 편집(Edit)
  { id: 'edit.selectAll', label: '전체 선택', group: '편집', defaultCombo: 'Ctrl+A' },
  { id: 'edit.escape', label: '선택 해제 / 크롭 종료', group: '편집', defaultCombo: 'Escape' },
  { id: 'edit.delete', label: '삭제', group: '편집', defaultCombo: 'Delete' },
  { id: 'edit.duplicate', label: '복제', group: '편집', defaultCombo: 'Ctrl+D' },
  { id: 'edit.undo', label: '실행취소', group: '편집', defaultCombo: 'Ctrl+Z' },
  { id: 'edit.redo', label: '다시실행', group: '편집', defaultCombo: 'Ctrl+Shift+Z' },
  { id: 'edit.toggleLock', label: '잠금 토글', group: '편집', defaultCombo: 'Alt+L' },

  // 정렬·배치(Arrange)
  { id: 'arrange.pack', label: '자동 배치(Pack)', group: '정렬', defaultCombo: 'Ctrl+P' },
  { id: 'arrange.group', label: '그룹', group: '정렬', defaultCombo: 'Ctrl+G' },
  { id: 'arrange.ungroup', label: '그룹 해제', group: '정렬', defaultCombo: 'Ctrl+Shift+G' },
  { id: 'arrange.alignLeft', label: '왼쪽 정렬', group: '정렬', defaultCombo: 'Ctrl+Left' },
  { id: 'arrange.alignRight', label: '오른쪽 정렬', group: '정렬', defaultCombo: 'Ctrl+Right' },
  { id: 'arrange.alignTop', label: '위 정렬', group: '정렬', defaultCombo: 'Ctrl+Up' },
  { id: 'arrange.alignBottom', label: '아래 정렬', group: '정렬', defaultCombo: 'Ctrl+Down' },
  { id: 'arrange.distributeH', label: '수평 균등 분배', group: '정렬', defaultCombo: 'Ctrl+Shift+Left' },
  { id: 'arrange.distributeV', label: '수직 균등 분배', group: '정렬', defaultCombo: 'Ctrl+Shift+Up' },
  { id: 'arrange.bringForward', label: '앞으로', group: '정렬', defaultCombo: ']' },
  { id: 'arrange.bringToFront', label: '맨 앞으로', group: '정렬', defaultCombo: 'Shift+]' },
  { id: 'arrange.sendBackward', label: '뒤로', group: '정렬', defaultCombo: '[' },
  { id: 'arrange.sendToBack', label: '맨 뒤로', group: '정렬', defaultCombo: 'Shift+[' },

  // 변형(Transform)
  { id: 'transform.crop', label: '자르기(Crop) 시작', group: '변형', defaultCombo: 'C' },
  { id: 'transform.resetCrop', label: '크롭 초기화', group: '변형', defaultCombo: 'Ctrl+Shift+C' },
  { id: 'transform.resetTransform', label: '변형 초기화', group: '변형', defaultCombo: 'Ctrl+Shift+T' },
  { id: 'transform.flipH', label: '좌우 반전', group: '변형', defaultCombo: 'Alt+Shift+H' },
  { id: 'transform.flipV', label: '상하 반전', group: '변형', defaultCombo: 'Alt+Shift+V' },

  // 파일(File)
  { id: 'file.import', label: '이미지 가져오기', group: '파일', defaultCombo: 'Ctrl+I' },
  { id: 'file.save', label: '저장', group: '파일', defaultCombo: 'Ctrl+S' },
  { id: 'file.open', label: '열기', group: '파일', defaultCombo: 'Ctrl+O' },
  { id: 'file.exportScene', label: '씬 내보내기(PNG)', group: '파일', defaultCombo: 'Ctrl+E' },
  { id: 'file.exportSelection', label: '선택 내보내기(PNG)', group: '파일', defaultCombo: 'Ctrl+Shift+E' },

  // 커맨드 팔레트(자기 자신) — command-palette.ts가 여는 키
  { id: 'app.commandPalette', label: '커맨드 팔레트', group: '앱', defaultCombo: 'Ctrl+Shift+P' },
]
