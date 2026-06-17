// 투명도 슬라이더 오버레이 — 선택된 아이템의 불투명도(opacity 0~1)를 조절하는 작은 플로팅 패널.
//
// 설계 원칙(minimap.ts와 동일):
//  - Scene/PixiJS에 의존하지 않는 독립 클래스. 자체 DOM을 만들어 host에 position:absolute로 얹는다.
//    scene.ts/board.ts/main.ts는 건드리지 않는다(단일 writer는 main). 이 컴포넌트는 "표시 + 값 통지"만 책임진다.
//  - 실제 아이템 불투명도 변경/히스토리 적재는 콜백(onInput/onChange)으로 main에 위임한다.
//  - 미니맵이 우하단을 쓰므로 겹치지 않게 우상단에 배치한다.
//
// 값 규약:
//  - 외부 API는 모두 0..1(value01)을 쓴다. range input은 0~100(%)이라 경계에서 *100 / /100 변환한다.
//  - onInput: 드래그 중 실시간(미리보기용, 히스토리 X) — 'input' 이벤트.
//  - onChange: 변경 확정(놓을 때, 히스토리 적재용) — 'change' 이벤트.

// ---- 시각 상수 ----
const OC_MARGIN = 12 // 우/상 여백(px) — 미니맵의 MM_MARGIN과 동일 감각
const OC_Z_INDEX = '60' // 미니맵(50)보다 위. 캔버스 위에 확실히 떠 있도록.

export class OpacityControl {
  private root: HTMLDivElement
  private slider: HTMLInputElement
  private label: HTMLSpanElement
  private visible = false

  // 드래그 중 실시간(미리보기용, 히스토리 X). main에서 아이템 alpha를 즉시 반영하는 용도.
  onInput?: (value01: number) => void
  // 변경 확정(놓을 때, 히스토리 적재용). main에서 undo 스택에 한 번만 쌓는 용도.
  onChange?: (value01: number) => void

  constructor(host: HTMLElement) {
    // ---- 루트 패널 ----
    const root = document.createElement('div')
    root.className = 'opacity-control'
    // 우상단 고정. 패널 영역만 포인터를 받고(pointer-events:auto), 그 외 영역은 캔버스로 흘려보낸다.
    root.style.cssText = [
      'position:absolute',
      `top:${OC_MARGIN}px`,
      `right:${OC_MARGIN}px`,
      'display:none', // show() 전 기본 숨김
      'align-items:center',
      'gap:8px',
      'padding:6px 10px',
      'border-radius:8px',
      'background:rgba(20, 20, 20, 0.78)', // 미니맵과 동일 톤의 반투명 어두운 배경
      'border:1px solid rgba(255, 255, 255, 0.18)',
      'box-shadow:0 2px 8px rgba(0, 0, 0, 0.35)',
      'color:#fff', // 흰 글씨
      "font:12px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
      'user-select:none',
      'pointer-events:auto', // 패널 자체만 포인터를 받는다(뒤 캔버스로 새지 않게)
      `z-index:${OC_Z_INDEX}`,
    ].join(';')

    // ---- 앞 텍스트(아이콘 대용 라벨) ----
    const title = document.createElement('span')
    title.textContent = '불투명도'
    title.style.cssText = 'opacity:0.8;white-space:nowrap'

    // ---- range input(0~100%) ----
    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = '0'
    slider.max = '100'
    slider.step = '1'
    slider.value = '100'
    slider.style.cssText = [
      'width:120px',
      'cursor:pointer',
      'accent-color:#4aa3ff', // 미니맵 뷰포트 강조색과 동일 계열
      'pointer-events:auto', // 슬라이더 자체는 조작 가능해야 한다
    ].join(';')

    // ---- 현재 % 텍스트 라벨 ----
    const label = document.createElement('span')
    label.textContent = '100%'
    // 자리수가 바뀌어도 폭이 흔들리지 않게 고정폭 + 우정렬.
    label.style.cssText = 'min-width:38px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap'

    root.appendChild(title)
    root.appendChild(slider)
    root.appendChild(label)

    // 'input' = 드래그 중 실시간, 'change' = 놓아서 확정.
    slider.addEventListener('input', this.handleInput)
    slider.addEventListener('change', this.handleChange)
    // 패널 내부의 포인터/휠 동작이 뒤 캔버스(팬/줌)로 전파되지 않도록 차단.
    // 패널 영역에서의 조작은 오직 슬라이더에만 작용해야 한다.
    root.addEventListener('pointerdown', stopEvent)
    root.addEventListener('wheel', stopEvent, { passive: false })

    host.appendChild(root)
    this.root = root
    this.slider = slider
    this.label = label
  }

  // 패널 표시 + 슬라이더/라벨을 주어진 값(0..1)에 동기화. 콜백은 발생하지 않는다.
  show(value01: number): void {
    this.applyValue(value01)
    this.visible = true
    this.root.style.display = 'flex'
  }

  // 패널 숨김. 상태(마지막 값)는 유지한다.
  hide(): void {
    this.visible = false
    this.root.style.display = 'none'
  }

  // 외부 변경을 UI에 반영(콜백 발생 안 함). 표시 여부는 바꾸지 않는다.
  setValue(value01: number): void {
    this.applyValue(value01)
  }

  // 현재 표시 여부.
  isVisible(): boolean {
    return this.visible
  }

  // 리스너 해제 + DOM 제거.
  destroy(): void {
    this.slider.removeEventListener('input', this.handleInput)
    this.slider.removeEventListener('change', this.handleChange)
    this.root.removeEventListener('pointerdown', stopEvent)
    this.root.removeEventListener('wheel', stopEvent)
    this.root.remove()
  }

  // ---- 내부 헬퍼 ----

  // 0..1 값을 0~100 정수로 변환해 슬라이더/라벨에 반영(콜백 없음).
  private applyValue(value01: number): void {
    const pct = clampPct(Math.round(value01 * 100))
    this.slider.value = String(pct)
    this.label.textContent = `${pct}%`
  }

  // 슬라이더 'input'(드래그 중) → 라벨 갱신 + onInput(value/100) 통지.
  private handleInput = (): void => {
    const pct = clampPct(Number(this.slider.value))
    this.label.textContent = `${pct}%`
    this.onInput?.(pct / 100)
  }

  // 슬라이더 'change'(놓을 때) → onChange(value/100) 통지(히스토리 적재용).
  private handleChange = (): void => {
    const pct = clampPct(Number(this.slider.value))
    this.label.textContent = `${pct}%`
    this.onChange?.(pct / 100)
  }
}

// 패널 내부 이벤트가 뒤 캔버스로 전파되지 않도록 차단(슬라이더 조작은 그대로 동작).
function stopEvent(e: Event): void {
  e.stopPropagation()
}

// 0~100 범위로 정수 클램프(NaN은 0 처리).
function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 100) return 100
  return Math.round(n)
}
