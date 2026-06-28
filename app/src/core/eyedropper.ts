/* eslint-disable @typescript-eslint/no-explicit-any --
   EyeDropper는 표준 타입이 없는 실험적 브라우저 API이고, PixiJS renderer.extract.pixels는
   v8 버전별 반환형 편차가 있어 의도적으로 any로 흡수한다(아래 런타임 가드로 안전성 확보). */
// 색상 추출(스포이드) — 화면의 한 픽셀 색을 뽑아 HEX/RGB로 돌려주고, 작은 스와치로 표시·복사한다.
//
// 설계 원칙:
//  - 순수 모듈. Scene/board에 의존하지 않고, 폴백에 필요한 renderer/stage만 "인자"로 받는다.
//    실제 호출 배선(렌더러/스테이지 전달, 결과 후처리)은 main이 담당한다.
//  - 추출 경로 2단계:
//      ① 1순위: window.EyeDropper(Chromium 계열) — OS 레벨 피커라 RefBoard 창 밖 화면(다른 앱·바탕화면)도
//         어디든 한 픽셀 추출 가능. 좌표 인자가 필요 없다(사용자가 화면을 클릭). 스펙의 "창 밖 화면도 추출" 충족.
//      ② 폴백: EyeDropper 미지원 브라우저에서만, PixiJS v8 renderer.extract로 stage의 해당 screen 좌표
//         1px을 읽는다(캔버스 내부로 한정). 둘 다 실패하면 null.
//  - 스와치/토스트는 settings-panel·opacity-control 등 기존 오버레이 톤(반투명 어두운 배경+흰 글씨,
//    position:fixed/absolute, 높은 z-index)을 따른다. document.body 위에 잠깐 떴다 사라진다.

// ---- 공개 타입 ----

// 추출된 색 1건. r/g/b/a는 0~255(alpha도 0~255로 통일), hex는 '#rrggbb'.
export interface PickedColor {
  r: number
  g: number
  b: number
  a: number
  hex: string
}

// ---- 시각 상수(기존 오버레이 톤) ----
const SW_Z_INDEX = '10001' // 모달(10000)보다 살짝 위. 스와치는 잠깐 뜨는 최상단 힌트.
const SW_AUTO_DISMISS_MS = 2600 // 클릭 없으면 이 시간 뒤 자동 소멸
const TOAST_MS = 1400 // "복사됨" 토스트 표시 시간

// ============================================================
//  ① 색상 추출
// ============================================================

/**
 * 한 픽셀의 색을 추출한다.
 *  - window.EyeDropper 지원 시: OS 피커를 열어(사용자 클릭) 화면 어디든 추출. opts 좌표는 무시.
 *  - 미지원 시: opts.renderer/stage/screenX/screenY로 캔버스 픽셀 폴백 추출.
 * @returns 성공 시 PickedColor, 사용자가 취소하거나 추출 불가하면 null.
 */
export async function pickColor(opts: {
  renderer?: any
  stage?: any
  screenX?: number
  screenY?: number
}): Promise<PickedColor | null> {
  // ① 1순위: 네이티브 EyeDropper(Chromium). 화면 어디든(창 밖 포함) 추출.
  const native = await pickWithNativeEyeDropper()
  if (native !== undefined) return native // null(사용자 취소) 포함해 네이티브 결과를 그대로 신뢰

  // ② 폴백: 캔버스 픽셀 추출(EyeDropper 미지원 브라우저에서만 도달).
  return pickFromRenderer(opts)
}

// 네이티브 EyeDropper 추출. 반환 의미:
//  - PickedColor: 추출 성공
//  - null: API는 있으나 사용자가 취소(Esc)
//  - undefined: API 자체가 없음(폴백으로 진행하라는 신호)
async function pickWithNativeEyeDropper(): Promise<PickedColor | null | undefined> {
  const Ctor = (globalThis as any).EyeDropper
  if (typeof Ctor !== 'function') return undefined // 미지원 → 폴백 신호
  try {
    const result = await new Ctor().open() // { sRGBHex: '#rrggbb' }
    const hex = result?.sRGBHex
    const parsed = typeof hex === 'string' ? hexToRgb(hex) : null
    if (!parsed) return null
    // 네이티브 피커는 알파를 주지 않으므로 불투명(255)으로 둔다.
    return { r: parsed.r, g: parsed.g, b: parsed.b, a: 255, hex: normalizeHex(hex) }
  } catch {
    // 사용자가 Esc로 닫으면 reject된다 → 취소로 간주(null).
    return null
  }
}

// PixiJS v8 폴백: renderer.extract로 stage의 (screenX, screenY) 1px을 읽는다.
// renderer/stage/좌표가 없거나 추출 실패면 null.
function pickFromRenderer(opts: {
  renderer?: any
  stage?: any
  screenX?: number
  screenY?: number
}): PickedColor | null {
  const { renderer, stage, screenX, screenY } = opts
  if (!renderer?.extract || !stage) return null
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return null

  try {
    // extract.pixels(target): RGBA Uint8(Clamped)Array + width/height. 전체 stage를 한 번 추출한 뒤
    // 해당 픽셀만 인덱싱한다(1px frame 추출은 v8에서 옵션 편차가 있어 안전하게 전체→인덱스).
    const out = renderer.extract.pixels(stage) as
      | { pixels: Uint8Array | Uint8ClampedArray; width: number; height: number }
      | (Uint8Array | Uint8ClampedArray)

    // v8 버전에 따라 반환형이 {pixels,width,height} 또는 배열 직접일 수 있어 양쪽을 흡수한다.
    const pixels: Uint8Array | Uint8ClampedArray = (out as any).pixels ?? (out as any)
    const width: number = (out as any).width ?? renderer.width ?? 0
    const height: number = (out as any).height ?? renderer.height ?? 0
    if (!pixels || width <= 0 || height <= 0) return null

    // screen 좌표(CSS px) → 추출 버퍼 좌표. 버퍼는 resolution 배율이 적용돼 있을 수 있으므로
    // renderer.resolution을 곱해 픽셀 인덱스를 보정한다.
    const res = Number(renderer.resolution) || 1
    const px = Math.round((screenX as number) * res)
    const py = Math.round((screenY as number) * res)
    if (px < 0 || py < 0 || px >= width || py >= height) return null

    const idx = (py * width + px) * 4
    const r = pixels[idx] ?? 0
    const g = pixels[idx + 1] ?? 0
    const b = pixels[idx + 2] ?? 0
    const a = pixels[idx + 3] ?? 255
    return { r, g, b, a, hex: rgbToHex(r, g, b) }
  } catch {
    return null
  }
}

// ============================================================
//  ② 추출 색 스와치(작은 플로팅 표시)
// ============================================================

// 동시에 하나만 — 새로 띄우면 기존 스와치를 먼저 정리한다.
let openSwatch: { el: HTMLElement; timer: number | null } | null = null

/**
 * 추출한 색을 화면 좌표(screenX, screenY) 근처에 작은 스와치로 띄운다.
 *  - 색 견본 + HEX 텍스트. 클릭하면 HEX를 클립보드에 복사하고 "복사됨" 토스트.
 *  - 몇 초 뒤(또는 클릭으로 복사한 직후 잠시 뒤) 자동으로 사라진다.
 */
export function showColorSwatch(color: PickedColor, screenX: number, screenY: number): void {
  dismissSwatch() // 기존 스와치 정리(중복 방지)

  // 화면 밖으로 넘치지 않게 좌표를 살짝 보정(우/하단으로 약간 띄움).
  const margin = 12
  const left = clamp(screenX + 14, margin, (globalThis.innerWidth || 1920) - 180)
  const top = clamp(screenY + 14, margin, (globalThis.innerHeight || 1080) - 60)

  const root = document.createElement('div')
  root.setAttribute('role', 'status')
  root.title = '클릭하면 HEX 복사'
  root.style.cssText = [
    'position:fixed',
    `left:${left}px`,
    `top:${top}px`,
    `z-index:${SW_Z_INDEX}`,
    'display:flex',
    'align-items:center',
    'gap:8px',
    'padding:6px 10px',
    'border-radius:8px',
    'background:rgba(20, 20, 20, 0.82)', // opacity-control과 동일 톤의 반투명 어두운 배경
    'border:1px solid rgba(255, 255, 255, 0.18)',
    'box-shadow:0 2px 8px rgba(0, 0, 0, 0.35)',
    'color:#fff',
    "font:12px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
    'user-select:none',
    'cursor:pointer',
  ].join(';')

  // 색 견본(추출색을 채운 작은 사각형). 체커보드 없이 단색으로 충분(알파는 텍스트가 보강).
  const chip = document.createElement('span')
  chip.style.cssText = [
    'flex:none',
    'width:18px',
    'height:18px',
    'border-radius:4px',
    'border:1px solid rgba(255,255,255,.35)',
    `background:${cssColor(color)}`,
  ].join(';')

  // HEX/RGB 텍스트(고정폭으로 흔들림 방지).
  const text = document.createElement('span')
  text.textContent = color.hex.toUpperCase()
  text.style.cssText = [
    'font:12px ui-monospace,SFMono-Regular,Menlo,monospace',
    'letter-spacing:.02em',
    'white-space:nowrap',
  ].join(';')

  root.appendChild(chip)
  root.appendChild(text)

  // 클릭 → HEX 복사 + 토스트. 복사 후 잠깐 뒤 스와치를 닫는다.
  root.addEventListener('click', () => {
    void copyColor(color, 'hex')
    showToast('복사됨', left, top)
    // 복사 피드백을 잠깐 보여준 뒤 정리.
    if (openSwatch?.timer) clearTimeout(openSwatch.timer)
    if (openSwatch) openSwatch.timer = window.setTimeout(dismissSwatch, 500)
  })

  document.body.appendChild(root)
  // 클릭이 없으면 일정 시간 뒤 자동 소멸.
  const timer = window.setTimeout(dismissSwatch, SW_AUTO_DISMISS_MS)
  openSwatch = { el: root, timer }
}

// 현재 떠 있는 스와치를 제거하고 타이머를 정리한다(중복 호출 안전).
function dismissSwatch(): void {
  if (!openSwatch) return
  if (openSwatch.timer) clearTimeout(openSwatch.timer)
  openSwatch.el.remove()
  openSwatch = null
}

// ============================================================
//  ③ 클립보드 복사
// ============================================================

/**
 * 추출한 색을 클립보드에 텍스트로 복사한다.
 *  - fmt='hex'(기본): '#RRGGBB'
 *  - fmt='rgb': 'rgb(r, g, b)' (알파가 불투명이 아니면 'rgba(r, g, b, a)')
 */
export async function copyColor(color: PickedColor, fmt: 'hex' | 'rgb' = 'hex'): Promise<void> {
  const value = fmt === 'rgb' ? toRgbString(color) : color.hex.toUpperCase()
  try {
    await navigator.clipboard?.writeText(value)
  } catch {
    // 클립보드 권한 거부/비보안 컨텍스트 등은 조용히 흡수(복사는 편의 기능).
    // execCommand 폴백(임시 textarea)으로 한 번 더 시도한다.
    fallbackCopy(value)
  }
}

// navigator.clipboard 미가용 환경용 폴백(임시 textarea + execCommand).
function fallbackCopy(value: string): void {
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  } catch {
    // 둘 다 실패하면 포기(예외를 밖으로 던지지 않는다).
  }
}

// ============================================================
//  내부 헬퍼
// ============================================================

// 작은 "복사됨" 토스트를 잠깐 띄운다(스와치 위쪽에 살짝).
function showToast(message: string, left: number, top: number): void {
  const toast = document.createElement('div')
  toast.textContent = message
  toast.style.cssText = [
    'position:fixed',
    `left:${left}px`,
    `top:${Math.max(4, top - 30)}px`,
    `z-index:${SW_Z_INDEX}`,
    'padding:4px 9px',
    'border-radius:6px',
    'background:rgba(74, 163, 255, 0.95)', // 강조색 계열(accent)로 복사 성공을 표시
    'color:#fff',
    "font:11px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
    'box-shadow:0 2px 8px rgba(0, 0, 0, 0.35)',
    'pointer-events:none', // 토스트는 클릭을 가로채지 않는다
    'user-select:none',
  ].join(';')
  document.body.appendChild(toast)
  window.setTimeout(() => toast.remove(), TOAST_MS)
}

// PickedColor → CSS 색 문자열(스와치 배경용). 알파가 불투명이면 hex, 아니면 rgba.
function cssColor(c: PickedColor): string {
  if (c.a >= 255) return c.hex
  return toRgbString(c)
}

// PickedColor → 'rgb(...)' 또는 'rgba(...)'. 알파(0~255)는 0~1로 환산.
function toRgbString(c: PickedColor): string {
  if (c.a >= 255) return `rgb(${c.r}, ${c.g}, ${c.b})`
  const a = Math.round((c.a / 255) * 1000) / 1000 // 소수 3자리로 정리
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`
}

// '#rgb'/'#rrggbb' → {r,g,b}(0~255). 형식 불가면 null.
function hexToRgb(input: string): { r: number; g: number; b: number } | null {
  const s = input.trim()
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s)
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

// r,g,b(0~255) → '#rrggbb'(소문자).
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => clampByte(v).toString(16).padStart(2, '0')).join('')
}

// 임의 hex 입력을 '#rrggbb' 표준형으로(불가하면 그대로 반환하되 소문자화).
function normalizeHex(input: string): string {
  const rgb = hexToRgb(input)
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : input.trim().toLowerCase()
}

// 0~255 정수로 클램프.
function clampByte(v: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(255, n))
}

// 수치를 [min,max]로 클램프(스와치 화면 밖 방지용).
function clamp(v: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, v))
}
