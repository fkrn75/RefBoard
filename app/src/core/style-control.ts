// 스타일 컨트롤 오버레이 — 선택 아이템(노트/드로잉) 또는 활성 도구의 색·굵기·글자크기·글꼴을 조절하는 플로팅 패널.
//
// 설계 원칙(opacity-control.ts와 동일):
//  - Scene/PixiJS/board에 의존하지 않는 독립 클래스. 자체 DOM을 host에 position:absolute로 얹는다.
//    실제 값 변경/히스토리 적재는 콜백(on*Input=미리보기 / on*Change=확정)으로 main에 위임한다.
//  - 투명도 패널(top:12)과 겹치지 않게 그 아래(top:52)에 배치한다.
//  - 네 항목(색/굵기/글자크기/글꼴)을 개별 그룹으로 두고, show()에 넘긴 항목만 표시한다
//    (드로잉=색+굵기, 텍스트=색+글자크기+글꼴, 둘 다 없으면 자동 숨김).
//
// 값 규약:
//  - on*Input: 드래그/선택 중 실시간(미리보기용, 히스토리 X) — 'input' 이벤트.
//  - on*Change: 변경 확정(놓을 때, 히스토리 적재용) — 'change' 이벤트. (글꼴 select는 change만)

// ---- 시각 상수 ----
const SC_MARGIN = 12 // 우 여백(px)
const SC_TOP = 52 // 투명도 패널(top:12 + 높이) 아래
const SC_Z_INDEX = '60' // 미니맵(50)보다 위

// 글꼴 선택 목록(시스템 generic + 한글 웹폰트). value=CSS font-family.
// 웹폰트(Noto/Nanum)는 index.html·viewer.html의 <link>로 로드된다. 없으면 generic 폴백으로 표시.
export const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '기본', value: 'Pretendard, -apple-system, "Malgun Gothic", sans-serif' },
  { label: '고딕', value: 'sans-serif' },
  { label: '명조', value: 'serif' },
  { label: '고정폭', value: 'monospace' },
  { label: 'Noto Sans', value: '"Noto Sans KR", sans-serif' },
  { label: '나눔고딕', value: '"Nanum Gothic", sans-serif' },
  { label: '나눔명조', value: '"Nanum Myeongjo", serif' },
  { label: '손글씨', value: '"Nanum Pen Script", cursive' },
]

// show()로 넘기는 값 — 정의된 항목만 패널에 표시된다.
export interface StyleValues {
  color?: string // #rrggbb — 있으면 색 그룹 표시
  width?: number // 선 굵기(px) — 있으면 굵기 그룹 표시
  fontSize?: number // 글자 크기(px) — 있으면 글자크기 그룹 표시
  fontFamily?: string // CSS font-family — 있으면 글꼴 드롭다운 표시
}

export class StyleControl {
  private root: HTMLDivElement
  private colorGroup: HTMLLabelElement
  private colorInput: HTMLInputElement
  private widthGroup: HTMLLabelElement
  private widthSlider: HTMLInputElement
  private widthLabel: HTMLSpanElement
  private fontGroup: HTMLLabelElement
  private fontSlider: HTMLInputElement
  private fontLabel: HTMLSpanElement
  private familyGroup: HTMLLabelElement
  private familySelect: HTMLSelectElement
  private visible = false

  // 미리보기(드래그 중, 히스토리 X) / 확정(놓을 때, 히스토리 O)
  onColorInput?: (hex: string) => void
  onColorChange?: (hex: string) => void
  onWidthInput?: (w: number) => void
  onWidthChange?: (w: number) => void
  onFontInput?: (s: number) => void
  onFontChange?: (s: number) => void
  onFontFamilyChange?: (family: string) => void // 글꼴 select 변경(확정)

  constructor(host: HTMLElement) {
    const root = document.createElement('div')
    root.className = 'style-control'
    root.style.cssText = [
      'position:absolute',
      `top:${SC_TOP}px`,
      `right:${SC_MARGIN}px`,
      'display:none', // show() 전 기본 숨김
      'align-items:center',
      'gap:12px',
      'padding:6px 10px',
      'border-radius:8px',
      'background:rgba(20, 20, 20, 0.78)', // 투명도 패널과 동일 톤
      'border:1px solid rgba(255, 255, 255, 0.18)',
      'box-shadow:0 2px 8px rgba(0, 0, 0, 0.35)',
      'color:#fff',
      "font:12px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
      'user-select:none',
      'pointer-events:auto', // 패널 자체만 포인터를 받는다(뒤 캔버스로 새지 않게)
      `z-index:${SC_Z_INDEX}`,
    ].join(';')

    // ---- 색상 그룹 ----
    const colorGroup = document.createElement('label')
    colorGroup.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer'
    const colorTitle = document.createElement('span')
    colorTitle.textContent = '색'
    colorTitle.style.cssText = 'opacity:0.8;white-space:nowrap'
    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    colorInput.style.cssText =
      'width:28px;height:20px;padding:0;border:1px solid rgba(255,255,255,.25);border-radius:4px;background:none;cursor:pointer'
    colorGroup.appendChild(colorTitle)
    colorGroup.appendChild(colorInput)

    // ---- 굵기 그룹 ----
    const widthGroup = document.createElement('label')
    widthGroup.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer'
    const widthTitle = document.createElement('span')
    widthTitle.textContent = '굵기'
    widthTitle.style.cssText = 'opacity:0.8;white-space:nowrap'
    const widthSlider = document.createElement('input')
    widthSlider.type = 'range'
    widthSlider.min = '1'
    widthSlider.max = '40'
    widthSlider.step = '1'
    widthSlider.style.cssText = 'width:80px;cursor:pointer;accent-color:#4aa3ff'
    const widthLabel = document.createElement('span')
    widthLabel.style.cssText = 'min-width:20px;text-align:right;font-variant-numeric:tabular-nums'
    widthGroup.appendChild(widthTitle)
    widthGroup.appendChild(widthSlider)
    widthGroup.appendChild(widthLabel)

    // ---- 글자크기 그룹 ----
    const fontGroup = document.createElement('label')
    fontGroup.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer'
    const fontTitle = document.createElement('span')
    fontTitle.textContent = '크기'
    fontTitle.style.cssText = 'opacity:0.8;white-space:nowrap'
    const fontSlider = document.createElement('input')
    fontSlider.type = 'range'
    fontSlider.min = '8'
    fontSlider.max = '160'
    fontSlider.step = '1'
    fontSlider.style.cssText = 'width:80px;cursor:pointer;accent-color:#4aa3ff'
    const fontLabel = document.createElement('span')
    fontLabel.style.cssText = 'min-width:28px;text-align:right;font-variant-numeric:tabular-nums'
    fontGroup.appendChild(fontTitle)
    fontGroup.appendChild(fontSlider)
    fontGroup.appendChild(fontLabel)

    // ---- 글꼴 그룹(드롭다운) ----
    const familyGroup = document.createElement('label')
    familyGroup.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer'
    const familyTitle = document.createElement('span')
    familyTitle.textContent = '글꼴'
    familyTitle.style.cssText = 'opacity:0.8;white-space:nowrap'
    const familySelect = document.createElement('select')
    familySelect.style.cssText =
      'background:rgba(40,40,40,.95);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:4px;padding:2px 4px;cursor:pointer;font:12px system-ui,sans-serif'
    for (const opt of FONT_OPTIONS) {
      const o = document.createElement('option')
      o.value = opt.value
      o.textContent = opt.label
      o.style.cssText = `font-family:${opt.value}` // 옵션 글자를 해당 글꼴로 미리보기
      familySelect.appendChild(o)
    }
    familyGroup.appendChild(familyTitle)
    familyGroup.appendChild(familySelect)

    root.appendChild(colorGroup)
    root.appendChild(widthGroup)
    root.appendChild(fontGroup)
    root.appendChild(familyGroup)

    // 'input' = 조작 중 실시간, 'change' = 놓아서 확정.
    colorInput.addEventListener('input', () => this.onColorInput?.(colorInput.value))
    colorInput.addEventListener('change', () => this.onColorChange?.(colorInput.value))
    widthSlider.addEventListener('input', () => {
      const w = Number(widthSlider.value)
      widthLabel.textContent = String(w)
      this.onWidthInput?.(w)
    })
    widthSlider.addEventListener('change', () => {
      const w = Number(widthSlider.value)
      widthLabel.textContent = String(w)
      this.onWidthChange?.(w)
    })
    fontSlider.addEventListener('input', () => {
      const s = Number(fontSlider.value)
      fontLabel.textContent = String(s)
      this.onFontInput?.(s)
    })
    fontSlider.addEventListener('change', () => {
      const s = Number(fontSlider.value)
      fontLabel.textContent = String(s)
      this.onFontChange?.(s)
    })
    familySelect.addEventListener('change', () => this.onFontFamilyChange?.(familySelect.value))

    // 패널 내부의 포인터/휠이 뒤 캔버스(팬/줌)로 전파되지 않도록 차단.
    root.addEventListener('pointerdown', stopEvent)
    root.addEventListener('wheel', stopEvent, { passive: false })

    host.appendChild(root)
    this.root = root
    this.colorGroup = colorGroup
    this.colorInput = colorInput
    this.widthGroup = widthGroup
    this.widthSlider = widthSlider
    this.widthLabel = widthLabel
    this.fontGroup = fontGroup
    this.fontSlider = fontSlider
    this.fontLabel = fontLabel
    this.familyGroup = familyGroup
    this.familySelect = familySelect
  }

  // 주어진 항목만 표시 + 값 동기화(콜백 없음). 셋 다 없으면 hide.
  show(v: StyleValues): void {
    let any = false
    if (v.color !== undefined) {
      this.colorInput.value = normalizeHex(v.color)
      this.colorGroup.style.display = ''
      any = true
    } else {
      this.colorGroup.style.display = 'none'
    }
    if (v.width !== undefined) {
      this.widthSlider.value = String(v.width)
      this.widthLabel.textContent = String(v.width)
      this.widthGroup.style.display = ''
      any = true
    } else {
      this.widthGroup.style.display = 'none'
    }
    if (v.fontSize !== undefined) {
      this.fontSlider.value = String(Math.round(v.fontSize))
      this.fontLabel.textContent = String(Math.round(v.fontSize))
      this.fontGroup.style.display = ''
      any = true
    } else {
      this.fontGroup.style.display = 'none'
    }
    if (v.fontFamily !== undefined) {
      // 목록에 없는 값이면 첫 옵션(기본)으로 폴백 표시.
      const known = FONT_OPTIONS.some((o) => o.value === v.fontFamily)
      this.familySelect.value = known ? v.fontFamily : FONT_OPTIONS[0].value
      this.familyGroup.style.display = ''
      any = true
    } else {
      this.familyGroup.style.display = 'none'
    }
    if (!any) {
      this.hide()
      return
    }
    this.visible = true
    this.root.style.display = 'flex'
  }

  // 패널 숨김. 상태(마지막 값)는 유지한다.
  hide(): void {
    this.visible = false
    this.root.style.display = 'none'
  }

  isVisible(): boolean {
    return this.visible
  }

  destroy(): void {
    this.root.remove()
  }
}

// 패널 내부 이벤트가 뒤 캔버스로 전파되지 않도록 차단(컨트롤 조작은 그대로 동작).
function stopEvent(e: Event): void {
  e.stopPropagation()
}

// input[type=color]는 반드시 #rrggbb(6자리) 형식만 받는다. 약식(#fff)·대문자·미상값을 보정한다.
function normalizeHex(c: string): string {
  if (typeof c !== 'string') return '#000000'
  const s = c.trim().toLowerCase()
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s)
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`
  if (/^#[0-9a-f]{6}$/.test(s)) return s
  return '#000000'
}
