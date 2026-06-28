// 설정 패널 — RefBoard Phase 4.4(색상 커스터마이징) + 4.5(단축키 설정) 통합 UI.
//
// 메뉴 바가 없는 RefBoard에서 "테마 색상"과 "키 바인딩"을 한 곳에서 편집하는 모달 오버레이다.
// command-palette.ts와 동일한 패턴(document.body 위 백드롭 + 패널, 캡처단계 키 처리, Esc/바깥클릭 닫기)을 따른다.
//
// 설계 원칙:
//  - 순수 DOM. PixiJS·캔버스와 무관하게 document.body 위에 떠서 동작한다.
//  - 기존 모듈(theme.ts/keymap.ts)은 "공개 export API만" 사용하고 절대 수정하지 않는다.
//      · 테마: listThemes / applyTheme / getCurrentTheme / onThemeChange (+ 타입 ThemeName/ThemeTokens/ResolvedTheme)
//      · 키맵: getActions / getBinding / rebind / resetBindings / findConflict / formatCombo (+ 타입 Action)
//  - 스타일은 theme.ts의 공식 --rb-* CSS 변수만 직접 참조한다(별칭 레이어 없음).
//    applyTheme 호출 전에도 각 var()의 fallback(다크 톤)으로 정상 렌더된다.
//  - theme.ts는 토큰 "키 목록/라벨"을 export하지 않으므로, 나열 순서·사람이 읽는 라벨은
//    이 모듈의 TOKEN_META(단일 출처)로 둔다. 실제 값은 항상 getCurrentTheme().tokens에서 읽는다.

import {
  type ResolvedTheme,
  type ThemeName,
  type ThemeTokens,
  applyTheme,
  getCurrentTheme,
  listThemes,
  onThemeChange,
} from './theme'
import {
  type Action,
  findConflict,
  formatCombo,
  getActions,
  getBinding,
  rebind,
  resetBindings,
} from './keymap'
import { MODAL_Z_INDEX } from './constants'
import { createFocusTrap, type FocusTrap } from './modal'
import { getRenderSettings, setPixelated } from './render-settings'

// ---- 탭 식별자 ----
export type SettingsTab = 'theme' | 'keys' | 'general'

// ---- 토큰 메타(나열 순서 + 라벨 + 프리셋 이름 라벨) ----
// theme.ts의 ThemeTokens 키 순서를 그대로 따르되, 각 토큰에 사람이 읽는 한국어 라벨을 부여한다.
// 새 토큰이 theme.ts에 추가되면 여기에도 한 줄 추가하면 색상 탭에 자동 노출된다(없으면 키명 그대로 표시).
interface TokenMeta {
  key: keyof ThemeTokens
  label: string
}
const TOKEN_META: TokenMeta[] = [
  { key: 'appBg', label: '앱 배경' },
  { key: 'canvasBg', label: '캔버스 배경' },
  { key: 'grid', label: '그리드(보조선)' },
  { key: 'gridMajor', label: '그리드(굵은선)' },
  { key: 'text', label: '기본 텍스트' },
  { key: 'textDim', label: '보조 텍스트' },
  { key: 'accent', label: '강조색' },
  { key: 'accentFg', label: '강조색 위 글자' },
  { key: 'warn', label: '경고색' },
  { key: 'panelBg', label: '패널 배경' },
  { key: 'panelBorder', label: '패널 테두리' },
  { key: 'selection', label: '선택 영역' },
  { key: 'backdrop', label: '모달 딤(바깥)' },
]

// 프리셋 이름 → 한국어 라벨.
const THEME_LABEL: Record<ThemeName, string> = {
  dark: '다크',
  light: '라이트',
  glass: '글래스',
}

// ---- 모듈 상태(싱글턴 오버레이) ----
// 설정 패널은 동시에 하나만 뜨면 충분하므로 모듈 레벨에 단일 인스턴스를 둔다.
let root: HTMLDivElement | null = null // 백드롭(가장 바깥). null이면 닫힌 상태
let bodyEl: HTMLDivElement | null = null // 탭 본문(여기만 탭 전환 시 다시 그린다)
let tabBtns: Partial<Record<SettingsTab, HTMLButtonElement>> = {}
let activeTab: SettingsTab = 'theme'

// 닫을 때 정확히 해제하기 위한 참조.
let onDocKeydown: ((e: KeyboardEvent) => void) | null = null
let unsubscribeTheme: (() => void) | null = null
let focusTrap: FocusTrap | null = null

// 재바인딩 캡처 모드 상태. 활성 시 다음 keydown 한 번을 가로채 해당 액션에 바인딩한다.
let capturingActionId: string | null = null
// 캡처 중인 행을 다시 그리기 위해 보관(상태 텍스트 갱신용).
let capturingRowRefresh: (() => void) | null = null

// ---- 공개 API ----

// 설정 패널이 열려 있는지.
export function isSettingsOpen(): boolean {
  return root !== null
}

// 설정 패널을 연다. tab으로 초기 탭 지정(기본 'theme').
// 이미 열려 있으면 탭만 전환한다(중복 오버레이 방지).
export function openSettings(tab: SettingsTab = 'theme'): void {
  if (root) {
    switchTab(tab)
    return
  }
  activeTab = tab
  buildDom()
  // 테마가 외부(다른 UI)에서 바뀌면 색상 탭을 다시 그려 입력값을 동기화한다.
  unsubscribeTheme = onThemeChange(() => {
    if (root && activeTab === 'theme') renderBody()
  })
}

// 설정 패널을 닫고 DOM·전역 리스너·구독을 정리한다(중복 호출 안전).
export function closeSettings(): void {
  if (!root) return
  cancelCapture() // 재바인딩 캡처 중이면 해제
  if (onDocKeydown) {
    document.removeEventListener('keydown', onDocKeydown, true)
    onDocKeydown = null
  }
  if (unsubscribeTheme) {
    unsubscribeTheme()
    unsubscribeTheme = null
  }
  focusTrap?.dispose()
  focusTrap = null
  root.remove()
  root = null
  bodyEl = null
  tabBtns = {}
  capturingActionId = null
  capturingRowRefresh = null
}

// ---- DOM 구성 ----

function buildDom(): void {
  // 백드롭: 화면 전체를 덮고 바깥 클릭 시 닫힘. 패널은 화면 중앙 상단에 배치.
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', '설정')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    `z-index:${MODAL_Z_INDEX}`,
    'display:flex',
    'justify-content:center',
    'align-items:flex-start',
    'padding-top:8vh',
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'font:14px system-ui,Segoe UI,sans-serif',
  ].join(';')
  // 바깥(백드롭) 클릭 시 닫기. 패널 내부 클릭은 stopPropagation으로 보호.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeSettings()
  })

  // 패널: 헤더(탭) + 본문 + 푸터.
  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:min(640px,94vw)',
    'max-height:84vh',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'border-radius:12px',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    // glass 테마 반투명 패널에 유리 질감(다른 테마는 불투명이라 무해).
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')
  panel.addEventListener('mousedown', (e) => e.stopPropagation())

  // ---- 헤더: 제목 + 탭 버튼 + 닫기 ----
  const header = document.createElement('div')
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:8px',
    'padding:10px 12px',
    'border-bottom:1px solid var(--rb-panel-border, #3a3a3a)',
    'flex:none',
  ].join(';')

  const title = document.createElement('strong')
  title.textContent = '설정'
  title.style.cssText = ['font-size:14px', 'margin-right:8px'].join(';')
  header.appendChild(title)

  // 탭 버튼 2개.
  tabBtns = {}
  for (const def of [
    { id: 'theme' as const, label: '테마' },
    { id: 'keys' as const, label: '단축키' },
    { id: 'general' as const, label: '일반' },
  ]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = def.label
    btn.style.cssText = tabButtonCss(false)
    btn.addEventListener('click', () => switchTab(def.id))
    tabBtns[def.id] = btn
    header.appendChild(btn)
  }

  // 우측 닫기 버튼(헤더 오른쪽 끝으로 밀기).
  const spacer = document.createElement('div')
  spacer.style.cssText = 'flex:1 1 auto'
  header.appendChild(spacer)

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '닫기')
  closeBtn.style.cssText = [
    'flex:none',
    'width:28px',
    'height:28px',
    'border-radius:6px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:transparent',
    'color:var(--rb-text-dim, #777)',
    'cursor:pointer',
    'font:inherit',
  ].join(';')
  closeBtn.addEventListener('click', () => closeSettings())
  header.appendChild(closeBtn)

  // ---- 본문(스크롤 영역) ----
  const body = document.createElement('div')
  body.style.cssText = ['overflow-y:auto', 'padding:14px', 'flex:1 1 auto', 'min-height:0'].join(';')

  panel.appendChild(header)
  panel.appendChild(body)
  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)

  // 키 입력은 캡처 단계에서 가로채 캔버스 단축키와 충돌하지 않게 한다.
  onDocKeydown = handleKeydown
  document.addEventListener('keydown', onDocKeydown, true)

  root = backdrop
  bodyEl = body
  focusTrap = createFocusTrap(backdrop)
  focusTrap.activate()

  // 초기 탭 반영(버튼 활성 표시 + 본문 렌더).
  applyTabButtonStyles()
  renderBody()
}

// 탭 버튼 스타일(활성/비활성).
function tabButtonCss(active: boolean): string {
  return [
    'flex:none',
    'padding:6px 14px',
    'border-radius:8px',
    'border:1px solid ' + (active ? 'var(--rb-accent, #4aa3ff)' : 'var(--rb-panel-border, #3a3a3a)'),
    'background:' + (active ? 'var(--rb-accent, #4aa3ff)' : 'transparent'),
    'color:' + (active ? 'var(--rb-accent-fg, #fff)' : 'var(--rb-text, #e6e6e6)'),
    'cursor:pointer',
    'font:inherit',
  ].join(';')
}

// 현재 activeTab에 맞춰 탭 버튼 강조를 갱신한다.
function applyTabButtonStyles(): void {
  for (const id of ['theme', 'keys', 'general'] as SettingsTab[]) {
    const btn = tabBtns[id]
    if (btn) btn.style.cssText = tabButtonCss(id === activeTab)
  }
}

// 탭 전환: 캡처 중이면 취소하고 본문을 다시 그린다.
function switchTab(tab: SettingsTab): void {
  if (activeTab === tab) {
    applyTabButtonStyles()
    return
  }
  cancelCapture()
  activeTab = tab
  applyTabButtonStyles()
  renderBody()
}

// 본문을 현재 탭에 맞춰 다시 그린다.
function renderBody(): void {
  if (!bodyEl) return
  bodyEl.textContent = ''
  if (activeTab === 'theme') renderThemeTab(bodyEl)
  else if (activeTab === 'keys') renderKeysTab(bodyEl)
  else renderGeneralTab(bodyEl)
}

// ============================================================
//  ① 테마 탭
// ============================================================

function renderThemeTab(host: HTMLDivElement): void {
  const theme = getCurrentTheme()

  // --- 프리셋 선택 행 ---
  const presetRow = document.createElement('div')
  presetRow.style.cssText = ['display:flex', 'align-items:center', 'gap:10px', 'margin-bottom:14px'].join(';')

  const presetLabel = document.createElement('span')
  presetLabel.textContent = '프리셋'
  presetLabel.style.cssText = ['font-size:13px', 'flex:none', 'min-width:64px'].join(';')
  presetRow.appendChild(presetLabel)

  const select = document.createElement('select')
  select.setAttribute('aria-label', '테마 프리셋')
  select.style.cssText = [
    'flex:none',
    'padding:6px 10px',
    'border-radius:8px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'font:inherit',
    'cursor:pointer',
  ].join(';')
  for (const name of listThemes()) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = THEME_LABEL[name] ?? name
    if (name === theme.name) opt.selected = true
    select.appendChild(opt)
  }
  // 프리셋 변경: 오버라이드를 버리고 깨끗한 프리셋으로 전환(즉시 적용·저장).
  select.addEventListener('change', () => {
    applyTheme(select.value as ThemeName)
    // onThemeChange 구독이 renderBody를 부르지만, 명시적으로도 한 번 더 그려 즉시 반영.
    renderBody()
  })
  presetRow.appendChild(select)

  // 프리셋 리셋 버튼(현재 프리셋의 오버라이드 전부 제거 = 순정 프리셋).
  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.textContent = '색상 초기화'
  resetBtn.title = '현재 프리셋의 커스텀 색상을 모두 지웁니다'
  resetBtn.style.cssText = secondaryButtonCss()
  resetBtn.addEventListener('click', () => {
    applyTheme(theme.name) // overrides 없이 = 순정 프리셋
    renderBody()
  })
  presetRow.appendChild(resetBtn)

  host.appendChild(presetRow)

  // --- 안내 문구 ---
  const hint = document.createElement('div')
  hint.textContent = '색상을 바꾸면 즉시 적용·저장됩니다. (rgba 등 hex가 아닌 값은 텍스트로 직접 입력)'
  hint.style.cssText = ['font-size:12px', 'color:var(--rb-text-dim, #777)', 'margin-bottom:12px'].join(';')
  host.appendChild(hint)

  // --- 토큰별 색상 편집 그리드 ---
  const grid = document.createElement('div')
  grid.style.cssText = ['display:flex', 'flex-direction:column', 'gap:8px'].join(';')

  for (const meta of TOKEN_META) {
    grid.appendChild(buildColorRow(meta, theme))
  }
  host.appendChild(grid)
}

// 한 토큰의 편집 행: [라벨] [색상칩(color input)] [텍스트 input].
// color input은 hex만 다루므로, rgba 등 비-hex 값은 텍스트 input으로 정확히 편집한다(피커는 근사치 표시).
function buildColorRow(meta: TokenMeta, theme: ResolvedTheme): HTMLElement {
  const value = theme.tokens[meta.key] // 항상 현재 적용값에서 읽는다
  const hex = toHexInputValue(value) // color input에 넣을 수 있는 #rrggbb(불가하면 null)

  const row = document.createElement('div')
  row.style.cssText = ['display:flex', 'align-items:center', 'gap:10px'].join(';')

  // 라벨.
  const label = document.createElement('label')
  label.textContent = meta.label
  label.style.cssText = ['font-size:13px', 'flex:none', 'min-width:120px'].join(';')
  row.appendChild(label)

  // 색상 칩(네이티브 color picker). hex가 아니면 근사 hex로 표시하되 값은 텍스트가 SSOT.
  const color = document.createElement('input')
  color.type = 'color'
  color.value = hex ?? '#000000'
  color.title = meta.key
  color.style.cssText = [
    'flex:none',
    'width:36px',
    'height:28px',
    'padding:0',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'border-radius:6px',
    'background:transparent',
    'cursor:pointer',
  ].join(';')

  // 텍스트 입력(정밀 값. rgba/hex 무엇이든 그대로 저장 가능).
  const text = document.createElement('input')
  text.type = 'text'
  text.value = value
  text.spellcheck = false
  text.setAttribute('aria-label', meta.label + ' 색상 값')
  text.style.cssText = [
    'flex:1 1 auto',
    'min-width:0',
    'padding:6px 8px',
    'border-radius:6px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:var(--rb-app-bg, #1e1e1e)',
    'color:var(--rb-text, #e6e6e6)',
    'font:12px ui-monospace,SFMono-Regular,Menlo,monospace',
  ].join(';')

  // color picker로 바꾸면 → 텍스트도 hex로 동기화하고 적용.
  color.addEventListener('input', () => {
    text.value = color.value
    setOverride(meta.key, color.value)
  })
  // 텍스트를 바꾸면 → (hex면) 색상칩도 동기화하고, 값이 비면 해당 오버라이드 제거(프리셋 값 복귀).
  const commitText = () => {
    const v = text.value.trim()
    if (v.length === 0) {
      clearOverride(meta.key)
      return
    }
    const h = toHexInputValue(v)
    if (h) color.value = h
    setOverride(meta.key, v)
  }
  text.addEventListener('change', commitText)

  row.appendChild(color)
  row.appendChild(text)
  return row
}

// 현재 테마에 토큰 오버라이드를 하나 추가/갱신하고 즉시 적용·저장한다.
// 기존 overrides를 보존한 채 해당 키만 덮어쓴다.
function setOverride(key: keyof ThemeTokens, value: string): void {
  const cur = getCurrentTheme()
  const overrides: Partial<ThemeTokens> = { ...(cur.overrides ?? {}) }
  overrides[key] = value
  applyTheme({ name: cur.name, overrides })
  // 색상칩만 바뀐 경우 전체 재렌더는 불필요(입력 포커스 유지). onThemeChange 구독이
  // renderBody를 호출하지만, 이 함수가 부른 applyTheme의 통지로 한 번만 다시 그려진다.
}

// 특정 토큰 오버라이드를 제거(= 프리셋 기본값으로 복귀)하고 즉시 적용·저장한다.
function clearOverride(key: keyof ThemeTokens): void {
  const cur = getCurrentTheme()
  if (!cur.overrides || !(key in cur.overrides)) {
    // 오버라이드가 없으면 프리셋 값으로 입력만 되돌리기 위해 재렌더.
    renderBody()
    return
  }
  const overrides: Partial<ThemeTokens> = { ...cur.overrides }
  delete overrides[key]
  applyTheme({ name: cur.name, overrides })
}

// 색 문자열을 <input type=color>가 받는 '#rrggbb'로 변환(불가하면 null).
//  - '#rgb'/'#rrggbb'는 그대로(확장) 채택.
//  - 'rgb()/rgba()'는 RGB 부분만 추출해 근사 hex로(피커 표시용. 알파/정밀도는 텍스트가 SSOT).
//  - 그 외(named color 등)는 null.
function toHexInputValue(input: string): string | null {
  const s = input.trim()
  const mHex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s)
  if (mHex) {
    let h = mHex[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    return '#' + h.toLowerCase()
  }
  const mRgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s)
  if (mRgb) {
    const r = clampByte(mRgb[1])
    const g = clampByte(mRgb[2])
    const b = clampByte(mRgb[3])
    return '#' + r + g + b
  }
  return null
}

// 0~255 정수 문자열 → 2자리 hex.
function clampByte(v: string): string {
  let n = Math.round(Number(v))
  if (!Number.isFinite(n)) n = 0
  n = Math.max(0, Math.min(255, n))
  return n.toString(16).padStart(2, '0')
}

// ============================================================
//  ② 단축키 탭
// ============================================================

function renderKeysTab(host: HTMLDivElement): void {
  // --- 상단 안내 + 전체 리셋 ---
  const top = document.createElement('div')
  top.style.cssText = ['display:flex', 'align-items:center', 'gap:10px', 'margin-bottom:12px'].join(';')

  const hint = document.createElement('div')
  hint.textContent = '"재바인딩"을 누른 뒤 원하는 키 조합을 누르세요. (Esc로 취소)'
  hint.style.cssText = ['font-size:12px', 'color:var(--rb-text-dim, #777)', 'flex:1 1 auto', 'min-width:0'].join(';')
  top.appendChild(hint)

  const resetAll = document.createElement('button')
  resetAll.type = 'button'
  resetAll.textContent = '기본값으로 초기화'
  resetAll.style.cssText = secondaryButtonCss()
  resetAll.addEventListener('click', () => {
    cancelCapture()
    resetBindings()
    renderBody()
  })
  top.appendChild(resetAll)
  host.appendChild(top)

  // --- 액션 표(그룹 헤더 + 행) ---
  const table = document.createElement('div')
  table.style.cssText = ['display:flex', 'flex-direction:column', 'gap:2px'].join(';')

  let lastGroup: string | undefined
  for (const action of getActions()) {
    // 그룹이 바뀌면 그룹 헤더를 끼운다.
    if (action.group && action.group !== lastGroup) {
      lastGroup = action.group
      const gh = document.createElement('div')
      gh.textContent = action.group
      gh.style.cssText = [
        'font-size:11px',
        'font-weight:600',
        'color:var(--rb-text-dim, #777)',
        'padding:10px 4px 4px',
        'letter-spacing:.04em',
      ].join(';')
      table.appendChild(gh)
    }
    table.appendChild(buildKeyRow(action))
  }
  host.appendChild(table)
}

// 한 액션의 행: [라벨] [현재 combo(또는 캡처 안내)] [재바인딩] [해제].
function buildKeyRow(action: Action): HTMLElement {
  const row = document.createElement('div')
  row.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:10px',
    'padding:6px 4px',
    'border-radius:6px',
  ].join(';')

  // 라벨.
  const label = document.createElement('span')
  label.textContent = action.label
  label.style.cssText = ['flex:1 1 auto', 'min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap'].join(';')
  row.appendChild(label)

  // combo 칩(현재 바인딩 또는 캡처중 안내).
  const kbd = document.createElement('span')
  kbd.style.cssText = comboChipCss(false)
  row.appendChild(kbd)

  // 충돌/안내 메시지(작게, 칩 아래가 아니라 우측 정렬 흐름에 끼움).
  const note = document.createElement('span')
  note.style.cssText = ['flex:none', 'font-size:11px', 'color:var(--rb-warn, #ff9800)', 'min-width:0'].join(';')
  row.appendChild(note)

  // 재바인딩 버튼.
  const rebindBtn = document.createElement('button')
  rebindBtn.type = 'button'
  rebindBtn.style.cssText = secondaryButtonCss()
  row.appendChild(rebindBtn)

  // 해제 버튼(빈 combo로 바인딩 = 어떤 키로도 호출 불가).
  const clearBtn = document.createElement('button')
  clearBtn.type = 'button'
  clearBtn.textContent = '해제'
  clearBtn.style.cssText = secondaryButtonCss()
  clearBtn.addEventListener('click', () => {
    cancelCapture()
    rebind(action.id, '') // 빈 문자열 = 바인딩 해제
    refresh()
  })
  row.appendChild(clearBtn)

  // 이 행의 표시를 현재 상태(바인딩/캡처중)에 맞춰 갱신한다.
  const refresh = () => {
    const isCapturing = capturingActionId === action.id
    const combo = getBinding(action.id)

    // combo 칩.
    if (isCapturing) {
      kbd.textContent = '키를 누르세요…'
      kbd.style.cssText = comboChipCss(true)
    } else {
      kbd.textContent = combo || '(없음)'
      kbd.style.cssText = comboChipCss(false)
      if (!combo) kbd.style.color = 'var(--rb-text-dim, #777)'
    }

    // 재바인딩 버튼 라벨.
    rebindBtn.textContent = isCapturing ? '취소' : '재바인딩'

    // 충돌 안내: 현재 바인딩이 다른 액션과 겹치면 경고.
    if (!isCapturing && combo) {
      const conflictId = findConflict(combo, action.id)
      if (conflictId) {
        const other = getActions().find((a) => a.id === conflictId)
        note.textContent = '⚠ "' + (other?.label ?? conflictId) + '"와 충돌'
        note.style.display = ''
      } else {
        note.textContent = ''
        note.style.display = 'none'
      }
    } else {
      note.textContent = ''
      note.style.display = 'none'
    }

    // 해제 버튼은 바인딩이 있을 때만 의미가 있다(없으면 흐리게·비활성).
    clearBtn.disabled = !combo || isCapturing
    clearBtn.style.opacity = clearBtn.disabled ? '0.4' : '1'
    clearBtn.style.cursor = clearBtn.disabled ? 'default' : 'pointer'
  }

  // 재바인딩 토글: 시작하면 이 행이 캡처 대상이 되고, 다시 누르면 취소.
  rebindBtn.addEventListener('click', () => {
    if (capturingActionId === action.id) {
      cancelCapture()
      return
    }
    startCapture(action.id, refresh)
  })

  refresh()
  return row
}

// ---- 재바인딩 캡처 ----

// 특정 액션의 키 캡처를 시작한다. 이전 캡처가 있으면 그 행을 먼저 정리한다.
function startCapture(actionId: string, rowRefresh: () => void): void {
  // 다른 행이 캡처 중이었다면 그 행 표시를 원복.
  const prevRefresh = capturingRowRefresh
  capturingActionId = actionId
  capturingRowRefresh = rowRefresh
  if (prevRefresh && prevRefresh !== rowRefresh) prevRefresh()
  rowRefresh()
}

// 진행 중인 캡처를 취소하고 해당 행을 원래 표시로 되돌린다.
function cancelCapture(): void {
  if (!capturingActionId) return
  const refresh = capturingRowRefresh
  capturingActionId = null
  capturingRowRefresh = null
  if (refresh) refresh()
}

// 캡처 중 눌린 키 조합을 해당 액션에 바인딩한다(충돌은 막지 않고 경고로 표시).
function commitCapture(e: KeyboardEvent): void {
  const id = capturingActionId
  if (!id) return
  const combo = formatCombo(e)
  if (!combo) return // 수식 키 단독 입력은 무시(메인 키가 눌릴 때까지 대기)

  rebind(id, combo)
  const refresh = capturingRowRefresh
  capturingActionId = null
  capturingRowRefresh = null
  if (refresh) refresh()
  // 충돌 경고는 각 행 refresh가 findConflict로 표시하지만, 다른 행(충돌 상대)의
  // 표시도 갱신돼야 하므로 단축키 탭 전체를 다시 그린다.
  if (activeTab === 'keys') renderBody()
}

// ============================================================
//  ③ 일반 탭
// ============================================================

function renderGeneralTab(host: HTMLDivElement): void {
  const s = getRenderSettings()

  // 섹션 제목.
  const heading = document.createElement('div')
  heading.textContent = '렌더링'
  heading.style.cssText = ['font-size:11px', 'font-weight:600', 'color:var(--rb-text-dim, #777)', 'padding:2px 4px 8px', 'letter-spacing:.04em'].join(';')
  host.appendChild(heading)

  // 픽셀 보간 토글 행(체크박스 + 설명).
  const row = document.createElement('label')
  row.style.cssText = ['display:flex', 'align-items:flex-start', 'gap:10px', 'cursor:pointer', 'padding:6px 4px'].join(';')

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = s.pixelated
  cb.style.cssText = ['width:16px', 'height:16px', 'cursor:pointer', 'flex:none', 'margin-top:2px'].join(';')
  cb.addEventListener('change', () => setPixelated(cb.checked))

  const textWrap = document.createElement('div')
  textWrap.style.cssText = ['display:flex', 'flex-direction:column', 'gap:2px', 'min-width:0'].join(';')
  const title = document.createElement('span')
  title.textContent = '픽셀 또렷하게 (확대 시 도트 유지)'
  title.style.cssText = 'font-size:13px'
  const desc = document.createElement('span')
  desc.textContent = '끄면 부드럽게 보간(기본), 켜면 확대해도 픽셀을 또렷이 유지합니다 — 픽셀아트 레퍼런스용.'
  desc.style.cssText = ['font-size:12px', 'color:var(--rb-text-dim, #777)', 'line-height:1.4'].join(';')
  textWrap.appendChild(title)
  textWrap.appendChild(desc)

  row.appendChild(cb)
  row.appendChild(textWrap)
  host.appendChild(row)
}

// ---- 공통 키 입력 처리(캡처 단계) ----

function handleKeydown(e: KeyboardEvent): void {
  if (!root) return

  // 재바인딩 캡처 모드: 모든 키를 가로채 바인딩(또는 Esc로 취소)한다.
  if (capturingActionId) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      cancelCapture()
      return
    }
    // 수식 키만 눌린 상태면 메인 키를 기다린다(commitCapture가 빈 combo를 무시).
    commitCapture(e)
    return
  }

  // 일반 모드: Esc로 패널 닫기. 그 외 키는 패널 내부 입력(텍스트/색상/셀렉트)이 받도록 두되,
  // 캔버스 단축키로 새지 않게 캡처 단계에서 멈춘다.
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeSettings()
    return
  }
  if (e.key === 'Tab') {
    e.stopPropagation()
    focusTrap?.handleKeydown(e)
    return
  }
  // 그 외 키는 폼 요소가 정상 동작하도록 두되, 전역 단축키로 전파만 차단.
  e.stopPropagation()
}

// ---- 공통 스타일 헬퍼 ----

// 보조 버튼(2차 액션) 공통 스타일.
function secondaryButtonCss(): string {
  return [
    'flex:none',
    'padding:6px 12px',
    'border-radius:8px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:transparent',
    'color:var(--rb-text, #e6e6e6)',
    'cursor:pointer',
    'font:inherit',
    'white-space:nowrap',
  ].join(';')
}

// combo 칩 스타일(일반/캡처중).
function comboChipCss(capturing: boolean): string {
  return [
    'flex:none',
    'min-width:120px',
    'text-align:center',
    'padding:5px 10px',
    'border-radius:6px',
    'border:1px solid ' + (capturing ? 'var(--rb-accent, #4aa3ff)' : 'var(--rb-panel-border, #3a3a3a)'),
    'background:' + (capturing ? 'var(--rb-accent, #4aa3ff)' : 'var(--rb-app-bg, #1e1e1e)'),
    'color:' + (capturing ? 'var(--rb-accent-fg, #fff)' : 'var(--rb-text, #e6e6e6)'),
    'font:12px ui-monospace,SFMono-Regular,Menlo,monospace',
  ].join(';')
}
