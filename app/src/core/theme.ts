// 테마 프리셋 시스템 — 순수 TS 모듈(PixiJS import 금지).
//
// 설계 원칙:
//  - 색상 "단일 출처(SSOT)"는 이 모듈의 프리셋 테이블이다. DOM(CSS 변수 --rb-*)과
//    PixiJS 캔버스(0xRRGGBB) 양쪽 모두 여기서 파생된다.
//  - applyTheme()가 document.documentElement(:root)에 --rb-* 변수를 주입하고 localStorage에 저장한다.
//    CSS/HTML 쪽은 var(--rb-...)만 참조하면 되고, 캔버스 쪽은 getCanvasColors()/onThemeChange()로 배선한다.
//  - 프리셋 + 부분 오버라이드(커스텀 색)를 지원한다. 오버라이드는 저장/복원되며 구독자에게도 전달된다.

// 테마가 정의하는 색상 토큰 키 집합. 값은 모두 CSS 색 문자열(#rrggbb 권장 — 캔버스 변환을 위해).
export interface ThemeTokens {
  appBg: string // body/문서 전체 배경
  canvasBg: string // PixiJS 캔버스 배경
  grid: string // 그리드 minor 라인
  gridMajor: string // 그리드 major 라인(굵은 라인)
  text: string // 기본 텍스트
  textDim: string // 흐린/보조 텍스트(#hint 등)
  accent: string // 강조색(선택 외곽선·기즈모 스트로크·러버밴드·강조 항목 배경)
  accentFg: string // 강조색 위에 얹는 텍스트(선택된 항목 글자)
  warn: string // 경고색(잠긴 항목 선택 외곽선 등)
  panelBg: string // 패널/툴바/오버레이 패널 배경
  panelBorder: string // 패널/오버레이 테두리
  selection: string // 선택 영역 채움/하이라이트
  backdrop: string // 모달/팔레트 바깥 딤(반투명 검정 권장)
}

// 프리셋 이름.
export type ThemeName = 'dark' | 'light' | 'glass'

// applyTheme/구독 콜백에 전달하는 정규화된 테마 상태.
export interface ResolvedTheme {
  name: ThemeName
  tokens: ThemeTokens // 프리셋 + 오버라이드가 모두 반영된 최종 토큰
  overrides?: Partial<ThemeTokens> // 사용자가 덮어쓴 부분(없으면 생략)
}

// applyTheme/getTheme의 입력 형태: 이름만 주거나, {name, overrides}로 부분 색을 덮어쓴다.
export type ThemeInput = ThemeName | { name: ThemeName; overrides?: Partial<ThemeTokens> }

const STORAGE_KEY = 'refboard.theme'
const DEFAULT_NAME: ThemeName = 'dark'

// 토큰 → CSS 변수명 매핑. (key) → --rb-(kebab)
// 통합 가이드/타 팀원(keymap 등)과 공유하는 공식 변수명의 단일 출처.
const CSS_VAR: Record<keyof ThemeTokens, string> = {
  appBg: '--rb-app-bg',
  canvasBg: '--rb-canvas-bg',
  grid: '--rb-grid',
  gridMajor: '--rb-grid-major',
  text: '--rb-text',
  textDim: '--rb-text-dim',
  accent: '--rb-accent',
  accentFg: '--rb-accent-fg',
  warn: '--rb-warn',
  panelBg: '--rb-panel-bg',
  panelBorder: '--rb-panel-border',
  selection: '--rb-selection',
  backdrop: '--rb-backdrop',
}

// 프리셋 3종. 값은 기존 scene.ts/index.html의 하드코딩 색(dark)을 그대로 옮겨 회귀가 없게 했다.
//  - dark.canvasBg=#1e1e1e, grid=#2c2c2c, gridMajor=#3a3a3a, accent=#4aa3ff, warn=#ff9800, textDim=#777
const PRESETS: Record<ThemeName, ThemeTokens> = {
  // 다크: 현행 기본값과 1:1 일치(시각적 회귀 없음).
  dark: {
    appBg: '#1e1e1e',
    canvasBg: '#1e1e1e',
    grid: '#2c2c2c',
    gridMajor: '#3a3a3a',
    text: '#e6e6e6',
    textDim: '#9a9a9a', // 보조 텍스트도 WCAG AA(>=4.5:1) 충족하도록 상향(기존 #777=3.42:1, a11y P2)
    accent: '#4aa3ff',
    accentFg: '#ffffff',
    warn: '#ff9800',
    panelBg: '#252526',
    panelBorder: '#3a3a3a',
    selection: '#4aa3ff',
    backdrop: 'rgba(0, 0, 0, 0.45)',
  },
  // 라이트: 밝은 배경 + 어두운 텍스트. 강조색은 가독성을 위해 약간 진한 파랑.
  light: {
    appBg: '#f3f3f3',
    canvasBg: '#fafafa',
    grid: '#e0e0e0',
    gridMajor: '#cccccc',
    text: '#1e1e1e',
    textDim: '#6a6a6a', // 보조 텍스트 WCAG AA 충족(기존 #888=3.54:1 미달, a11y P2)
    accent: '#2f7fe0',
    accentFg: '#ffffff',
    warn: '#e06c00',
    panelBg: '#ffffff',
    panelBorder: '#d0d0d0',
    selection: '#2f7fe0',
    backdrop: 'rgba(0, 0, 0, 0.30)',
  },
  // 글래스: 어두운 반투명 패널 느낌(패널 배경/테두리에 알파 포함 — rgba 문자열).
  // canvasBg는 캔버스 변환을 위해 불투명 hex 유지(알파는 캔버스에서 무의미).
  glass: {
    appBg: '#0f1115',
    canvasBg: '#12151b',
    grid: '#222831',
    gridMajor: '#313a47',
    text: '#eef2f7',
    textDim: '#8a93a3',
    accent: '#5cc8ff',
    accentFg: '#0f1115',
    warn: '#ffb74d',
    panelBg: 'rgba(28, 33, 43, 0.72)',
    panelBorder: 'rgba(255, 255, 255, 0.12)',
    selection: '#5cc8ff',
    backdrop: 'rgba(0, 0, 0, 0.55)',
  },
}

// 현재 적용된 테마 상태(메모리 캐시). applyTheme로 갱신, 구독 통지의 기준.
let current: ResolvedTheme = { name: DEFAULT_NAME, tokens: PRESETS[DEFAULT_NAME] }

// 변경 구독자 집합.
type ThemeListener = (theme: ResolvedTheme) => void
const listeners = new Set<ThemeListener>()

// ThemeInput을 {name, overrides}로 정규화. 잘못된 이름은 기본값으로 폴백한다.
function normalizeInput(input: ThemeInput): { name: ThemeName; overrides?: Partial<ThemeTokens> } {
  if (typeof input === 'string') {
    return { name: isThemeName(input) ? input : DEFAULT_NAME }
  }
  const name = isThemeName(input?.name) ? input.name : DEFAULT_NAME
  return { name, overrides: input?.overrides }
}

// 유효한 프리셋 이름인지 검사(타입 가드).
function isThemeName(v: unknown): v is ThemeName {
  return v === 'dark' || v === 'light' || v === 'glass'
}

// 프리셋 + 오버라이드를 합쳐 최종 토큰을 만든다(오버라이드의 undefined 값은 무시).
function resolveTokens(name: ThemeName, overrides?: Partial<ThemeTokens>): ThemeTokens {
  const base = PRESETS[name]
  if (!overrides) return { ...base }
  const merged: ThemeTokens = { ...base }
  for (const key of Object.keys(CSS_VAR) as (keyof ThemeTokens)[]) {
    const v = overrides[key]
    if (typeof v === 'string' && v.length > 0) merged[key] = v
  }
  return merged
}

// '#rgb'/'#rrggbb' → 0xRRGGBB number. hex가 아닌 값(rgba 등)이나 파싱 실패 시 fallback 반환.
function hexToNumber(hex: string, fallback: number): number {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return fallback
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] // #rgb → #rrggbb 확장
  return parseInt(h, 16)
}

// ---- 공개 API ----

// 프리셋 이름 목록(드롭다운 구성용).
export function listThemes(): ThemeName[] {
  return ['dark', 'light', 'glass']
}

// 테마 적용: --rb-* CSS 변수를 :root에 주입 + localStorage 저장 + 구독자 통지.
// 입력은 이름('dark') 또는 {name, overrides}(부분 색 덮어쓰기).
export function applyTheme(input: ThemeInput): ResolvedTheme {
  const { name, overrides } = normalizeInput(input)
  const tokens = resolveTokens(name, overrides)
  const hasOverrides = !!overrides && Object.keys(overrides).length > 0

  // :root에 모든 토큰을 CSS 변수로 주입(SSR/비DOM 환경 방어).
  const root =
    typeof document !== 'undefined' ? document.documentElement : undefined
  if (root) {
    for (const key of Object.keys(CSS_VAR) as (keyof ThemeTokens)[]) {
      root.style.setProperty(CSS_VAR[key], tokens[key])
    }
  }

  // 캐시 갱신 후 저장 + 통지.
  current = hasOverrides ? { name, tokens, overrides } : { name, tokens }
  saveToStorage(current)
  for (const cb of listeners) cb(current)
  return current
}

// 저장된 테마를 복원해 반환(부작용 없음 — 적용은 하지 않는다).
// 부팅 시 getTheme()로 읽어 applyTheme()에 넘기는 패턴을 권장.
// 저장값이 없거나 손상되면 기본('dark')을 돌려준다.
export function getTheme(): ResolvedTheme {
  const stored = loadFromStorage()
  if (!stored) return { name: DEFAULT_NAME, tokens: PRESETS[DEFAULT_NAME] }
  const tokens = resolveTokens(stored.name, stored.overrides)
  return stored.overrides && Object.keys(stored.overrides).length > 0
    ? { name: stored.name, tokens, overrides: stored.overrides }
    : { name: stored.name, tokens }
}

// 현재 메모리상 적용된 테마(applyTheme로 갱신된 최신 상태).
export function getCurrentTheme(): ResolvedTheme {
  return current
}

// PixiJS용 색상: 현재 테마의 캔버스 관련 토큰을 0xRRGGBB number로 반환.
// hex가 아닌 토큰(glass의 rgba 등)은 안전한 기본값으로 폴백한다.
export function getCanvasColors(): {
  canvasBg: number
  grid: number
  gridMajor: number
  accent: number
  warn: number
  selection: number
} {
  const t = current.tokens
  return {
    canvasBg: hexToNumber(t.canvasBg, 0x1e1e1e),
    grid: hexToNumber(t.grid, 0x2c2c2c),
    gridMajor: hexToNumber(t.gridMajor, 0x3a3a3a),
    accent: hexToNumber(t.accent, 0x4aa3ff),
    warn: hexToNumber(t.warn, 0xff9800),
    selection: hexToNumber(t.selection, 0x4aa3ff),
  }
}

// 테마 변경 구독. 콜백은 등록 즉시 1회 호출되지 않으며(현재 상태가 필요하면 getCurrentTheme 사용),
// 이후 applyTheme가 호출될 때마다 최신 ResolvedTheme를 받는다. 반환된 함수로 구독 해제.
export function onThemeChange(cb: ThemeListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// ---- localStorage 입출력(손상/비가용 환경 방어) ----

interface StoredTheme {
  name: ThemeName
  overrides?: Partial<ThemeTokens>
}

function saveToStorage(theme: ResolvedTheme): void {
  try {
    const payload: StoredTheme = theme.overrides
      ? { name: theme.name, overrides: theme.overrides }
      : { name: theme.name }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // localStorage 비가용(프라이빗 모드/용량 초과 등) — 무시하고 메모리 상태만 유지.
  }
}

function loadFromStorage(): StoredTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const obj = parsed as { name?: unknown; overrides?: unknown }
    if (!isThemeName(obj.name)) return null
    // overrides는 부분 토큰 맵(문자열 값만 채택). 형식이 어긋나면 버린다.
    let overrides: Partial<ThemeTokens> | undefined
    if (obj.overrides && typeof obj.overrides === 'object') {
      const src = obj.overrides as Record<string, unknown>
      const out: Partial<ThemeTokens> = {}
      for (const key of Object.keys(CSS_VAR) as (keyof ThemeTokens)[]) {
        const v = src[key]
        if (typeof v === 'string' && v.length > 0) out[key] = v
      }
      if (Object.keys(out).length > 0) overrides = out
    }
    return overrides ? { name: obj.name, overrides } : { name: obj.name }
  } catch {
    return null // 손상된 JSON 등 — 기본값으로 폴백.
  }
}
