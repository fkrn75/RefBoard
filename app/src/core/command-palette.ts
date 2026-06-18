// 커맨드 팔레트 — RefBoard Phase 4.5.
//
// 메뉴 바가 없는 RefBoard에서 "모든 명령을 검색·실행"하는 보완 UI.
// Ctrl+Shift+P 등으로 열리는 DOM 오버레이(검색 input + 결과 리스트)다.
//
// 설계 원칙:
//  - 순수 DOM. PixiJS·캔버스와 무관하게 document.body 위에 떠서 동작한다.
//  - keymap.ts의 Action 목록을 받아 보여주되, 실행은 onRun(actionId) 콜백에 위임한다
//    (팔레트는 "무엇을 고를지"만 담당, "어떻게 실행할지"는 호출측 main.ts 책임).
//  - 스타일은 theme.ts의 공식 --rb-* CSS 변수를 직접 참조한다(SSOT 일원화: 별칭 레이어 없음).
//    배경=--rb-panel-bg, 글자=--rb-text, 보조=--rb-text-dim, 테두리=--rb-panel-border,
//    강조=--rb-accent/--rb-accent-fg, 바깥딤=--rb-backdrop. applyTheme() 호출 전에도
//    각 var()의 fallback(다크 톤)으로 정상 렌더된다(theme.ts 부팅 배선은 main.ts 담당).
//  - 단축키 표기는 Action.defaultCombo가 아니라 getBinding(현재 유효 바인딩)을 보여줘
//    사용자가 재바인딩한 키가 그대로 반영되게 한다.

import { type Action, getBinding } from './keymap'

// ---- 모듈 상태(싱글턴 오버레이) ----
// 팔레트는 동시에 하나만 뜨면 충분하므로 모듈 레벨에 단일 인스턴스를 둔다.
let root: HTMLDivElement | null = null // 백드롭(가장 바깥). null이면 닫힌 상태
let input: HTMLInputElement | null = null
let listEl: HTMLDivElement | null = null
let onRunCb: ((actionId: string) => void) | null = null

let allActions: Action[] = [] // 열 때 전달받은 전체 액션
let filtered: Action[] = [] // 현재 검색어로 추린 결과
let activeIndex = 0 // 키보드 하이라이트 위치(filtered 기준)

// 외부에서 주입되는 이벤트 핸들러 참조(닫을 때 정확히 해제하기 위해 보관).
let onDocKeydown: ((e: KeyboardEvent) => void) | null = null

// ---- 공개 API ----

// 팔레트가 열려 있는지.
export function isPaletteOpen(): boolean {
  return root !== null
}

// 팔레트를 연다.
//  - actions: 보여줄(검색 대상) 액션 목록. 보통 keymap의 getActions().
//  - onRun: 항목 실행 시 호출(선택된 actionId 전달). 실행 후 팔레트는 자동으로 닫힌다.
// 이미 열려 있으면 목록만 새로 적용하고 검색을 초기화한다(중복 오버레이 방지).
export function openPalette(actions: Action[], onRun: (actionId: string) => void): void {
  allActions = actions
  onRunCb = onRun
  if (root) {
    // 이미 떠 있으면 입력만 비우고 다시 채운다.
    if (input) input.value = ''
    refilter('')
    input?.focus()
    return
  }
  buildDom()
  refilter('')
  // 입력 포커스는 다음 프레임에(요소가 레이아웃된 뒤) 줘야 안정적이다.
  requestAnimationFrame(() => input?.focus())
}

// 팔레트를 닫고 DOM·전역 리스너를 정리한다(중복 호출 안전).
export function closePalette(): void {
  if (!root) return
  if (onDocKeydown) {
    document.removeEventListener('keydown', onDocKeydown, true)
    onDocKeydown = null
  }
  root.remove()
  root = null
  input = null
  listEl = null
  onRunCb = null
  allActions = []
  filtered = []
  activeIndex = 0
}

// ---- DOM 구성 ----

function buildDom(): void {
  // 백드롭: 화면 전체를 덮고 클릭 시 닫힘. 내부 패널은 상단 1/5 지점에 배치.
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', '커맨드 팔레트')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10000',
    'display:flex',
    'justify-content:center',
    'align-items:flex-start',
    'padding-top:12vh',
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'font:14px system-ui,Segoe UI,sans-serif',
  ].join(';')

  // 바깥(백드롭) 클릭 시 닫기. 패널 내부 클릭은 stopPropagation으로 보호.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closePalette()
  })

  // 패널: 검색 input + 결과 리스트를 담는 컨테이너.
  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:min(560px,92vw)',
    'max-height:60vh',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'border-radius:12px',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    // glass 테마의 반투명 panel-bg에 유리 질감을 준다. dark/light는 panel-bg가
    // 불투명이라 시각적 영향이 없다(무해). webkit 접두사로 사파리 호환 확보.
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')
  panel.addEventListener('mousedown', (e) => e.stopPropagation())

  // 검색 input.
  const inp = document.createElement('input')
  inp.type = 'text'
  inp.placeholder = '명령 검색…'
  inp.setAttribute('aria-label', '명령 검색')
  inp.style.cssText = [
    'box-sizing:border-box',
    'width:100%',
    'padding:14px 16px',
    'border:none',
    'outline:none',
    'background:transparent',
    'color:inherit',
    'font:inherit',
    'border-bottom:1px solid var(--rb-panel-border, #3a3a3a)',
  ].join(';')
  inp.addEventListener('input', () => refilter(inp.value))

  // 결과 리스트(스크롤 영역).
  const list = document.createElement('div')
  list.style.cssText = ['overflow-y:auto', 'padding:6px', 'flex:1 1 auto', 'min-height:0'].join(';')

  panel.appendChild(inp)
  panel.appendChild(list)
  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)

  // 키 입력은 캡처 단계에서 가로채 캔버스 단축키와 충돌하지 않게 한다.
  onDocKeydown = handleKeydown
  document.addEventListener('keydown', onDocKeydown, true)

  root = backdrop
  input = inp
  listEl = list
}

// ---- 검색/렌더 ----

// 검색어로 액션을 추려 filtered를 갱신하고 리스트를 다시 그린다.
//  - 부분일치(대소문자 무시): label 또는 group에 검색어가 포함되면 매칭.
//  - 빈 검색어면 전체를 그대로 보여준다(등록 순서 유지).
function refilter(query: string): void {
  const q = query.trim().toLowerCase()
  if (!q) {
    filtered = allActions.slice()
  } else {
    filtered = allActions.filter((a) => {
      const hay = (a.label + ' ' + (a.group ?? '') + ' ' + a.id).toLowerCase()
      return hay.includes(q)
    })
  }
  activeIndex = 0
  renderList()
}

// filtered를 DOM 리스트로 렌더한다. 각 행: 라벨(+그룹) | 현재 단축키.
function renderList(): void {
  if (!listEl) return
  listEl.textContent = ''

  if (filtered.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = '일치하는 명령이 없습니다'
    empty.style.cssText = ['padding:16px', 'text-align:center', 'color:var(--rb-text-dim, #777)'].join(';')
    listEl.appendChild(empty)
    return
  }

  filtered.forEach((a, i) => {
    const row = document.createElement('div')
    row.dataset.index = String(i)
    row.style.cssText = [
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:12px',
      'padding:9px 12px',
      'border-radius:8px',
      'cursor:pointer',
      'user-select:none',
    ].join(';')

    // 왼쪽: 그룹(작게) + 라벨.
    const left = document.createElement('span')
    left.style.cssText = ['display:flex', 'align-items:baseline', 'gap:8px', 'min-width:0'].join(';')
    if (a.group) {
      const g = document.createElement('span')
      g.textContent = a.group
      g.style.cssText = ['font-size:11px', 'color:var(--rb-text-dim, #777)', 'flex:none'].join(';')
      left.appendChild(g)
    }
    const label = document.createElement('span')
    label.textContent = a.label
    label.style.cssText = ['overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap'].join(';')
    left.appendChild(label)

    // 오른쪽: 현재 유효 단축키(없으면 비움).
    const combo = getBinding(a.id)
    const kbd = document.createElement('span')
    kbd.textContent = combo
    kbd.style.cssText = [
      'flex:none',
      'font-size:12px',
      'color:var(--rb-text-dim, #777)',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    ].join(';')

    row.appendChild(left)
    row.appendChild(kbd)

    // 마우스 호버는 하이라이트를 그 행으로 옮기고, 클릭은 즉시 실행.
    row.addEventListener('mousemove', () => setActive(i))
    row.addEventListener('click', () => runIndex(i))

    listEl?.appendChild(row)
  })

  applyActiveStyles()
}

// 하이라이트(activeIndex)를 옮기고 스타일·스크롤을 갱신한다.
function setActive(i: number): void {
  if (filtered.length === 0) return
  // 범위를 순환(위/아래로 끝에서 반대편으로 넘어가게)시킨다.
  const n = filtered.length
  activeIndex = ((i % n) + n) % n
  applyActiveStyles()
}

// 현재 activeIndex에 맞춰 각 행의 배경을 칠하고, 보이도록 스크롤한다.
function applyActiveStyles(): void {
  if (!listEl) return
  const rows = listEl.children
  for (let i = 0; i < rows.length; i++) {
    const el = rows[i] as HTMLElement
    if (el.dataset.index === undefined) continue // "결과 없음" 행 등은 건너뜀
    const on = Number(el.dataset.index) === activeIndex
    el.style.background = on ? 'var(--rb-accent, #3b82f6)' : 'transparent'
    el.style.color = on ? 'var(--rb-accent-fg, #fff)' : 'inherit'
    if (on) el.scrollIntoView({ block: 'nearest' })
  }
}

// i번째 결과를 실행한다(콜백 호출 후 팔레트 닫기).
function runIndex(i: number): void {
  const a = filtered[i]
  if (!a) return
  const cb = onRunCb
  const id = a.id
  closePalette() // 먼저 닫아 콜백이 다시 팔레트를 열어도 상태가 꼬이지 않게.
  cb?.(id)
}

// ---- 키 입력 ----

// 팔레트 전용 키 처리(캡처 단계). 여기서 처리한 키는 캔버스로 새지 않게 막는다.
function handleKeydown(e: KeyboardEvent): void {
  if (!root) return
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      closePalette()
      break
    case 'ArrowDown':
      e.preventDefault()
      e.stopPropagation()
      setActive(activeIndex + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      e.stopPropagation()
      setActive(activeIndex - 1)
      break
    case 'Enter':
      e.preventDefault()
      e.stopPropagation()
      runIndex(activeIndex)
      break
    default:
      // 그 외 키(글자 입력 등)는 input이 받도록 두되, 캔버스 단축키로는 새지 않게 막는다.
      e.stopPropagation()
      break
  }
}
