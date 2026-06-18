// 이미지 풀스크린 라이트박스 — RefBoard Phase 5(웹 공유) 읽기전용 뷰어.
//
// 보드 썸네일/아이템을 클릭하면 화면 전체를 덮는 오버레이로 한 장씩 크게 본다.
// 다음/이전 네비(← → 키 + 좌우 버튼), Esc 닫기, 배경 클릭 닫기, 캡션(제목/순번),
// 마우스 휠 줌 + 더블클릭 리셋을 제공한다.
//
// 설계 원칙(command-palette.ts와 일관):
//  - 순수 DOM. PixiJS·캔버스·board 렌더와 무관하게 document.body 위에 떠서 동작한다.
//    입력은 { id, src, title? } 배열만 받는다(BoardImage 전체가 아니라 표시에 필요한 최소형).
//  - 스타일은 theme.ts의 공식 --rb-* CSS 변수를 직접 참조하고, applyTheme() 전에도
//    각 var()의 fallback(다크 톤)으로 정상 렌더된다.
//  - 키 입력은 캡처 단계에서 가로채 캔버스/문서 단축키와 충돌하지 않게 막는다.
//  - 동시에 하나만 뜨면 충분하므로 모듈 레벨 단일 인스턴스로 둔다(중복 오버레이 방지).
//  - 터치 핀치 줌은 mobile 팀원 담당이라 여기선 마우스/키 입력만 다룬다.

// 라이트박스가 표시하는 한 장의 항목(표시에 필요한 최소 정보).
export interface LightboxItem {
  id: string
  src: string // data URL 또는 링크(파일/웹 경로)
  title?: string // 캡션에 쓰는 제목(없으면 순번만 표시)
}

// ---- 모듈 상태(싱글턴 오버레이) ----
// null이면 닫힌 상태. 열려 있는 동안에만 각 참조가 채워진다.
let root: HTMLDivElement | null = null // 백드롭(가장 바깥)
let imgEl: HTMLImageElement | null = null // 현재 표시 중인 이미지
let captionEl: HTMLDivElement | null = null // 하단 캡션(제목 + 순번)
let prevBtn: HTMLButtonElement | null = null
let nextBtn: HTMLButtonElement | null = null

let items: LightboxItem[] = [] // 열 때 전달받은 전체 목록
let index = 0 // 현재 보고 있는 항목 위치(items 기준)
let zoom = 1 // 현재 줌 배율(1 = 원본 맞춤). 휠로 변경, 더블클릭 리셋

// 외부에서 주입한 문서 키 핸들러(닫을 때 정확히 해제하기 위해 보관).
let onDocKeydown: ((e: KeyboardEvent) => void) | null = null

// 줌 한계 — 너무 작아 사라지거나 과하게 커지는 것을 막는다.
const ZOOM_MIN = 0.2
const ZOOM_MAX = 8
const ZOOM_STEP = 1.15 // 휠 한 칸당 곱/나눗셈 배율

// ---- 공개 API ----

// 라이트박스가 열려 있는지.
export function isLightboxOpen(): boolean {
  return root !== null
}

// 라이트박스를 연다.
//  - list: 표시할 항목 목록(보통 보드의 이미지들).
//  - startIndex: 처음 보여줄 항목 위치(범위를 벗어나면 양끝으로 클램프).
// 이미 열려 있으면 목록만 새로 적용하고 해당 위치로 이동한다(중복 오버레이 방지).
export function openLightbox(list: LightboxItem[], startIndex: number): void {
  if (list.length === 0) return // 보여줄 게 없으면 열지 않는다.
  items = list.slice()
  index = clampIndex(startIndex)
  if (root) {
    // 이미 떠 있으면 DOM은 그대로 두고 현재 항목만 갱신.
    show(index)
    return
  }
  buildDom()
  show(index)
}

// 라이트박스를 닫고 DOM·전역 리스너를 정리한다(중복 호출 안전).
export function closeLightbox(): void {
  if (!root) return
  if (onDocKeydown) {
    document.removeEventListener('keydown', onDocKeydown, true)
    onDocKeydown = null
  }
  root.remove()
  root = null
  imgEl = null
  captionEl = null
  prevBtn = null
  nextBtn = null
  items = []
  index = 0
  zoom = 1
}

// ---- DOM 구성 ----

function buildDom(): void {
  // 백드롭: 화면 전체를 덮는 어두운 오버레이. 빈 영역 클릭 시 닫힘.
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', '이미지 뷰어')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10001', // 커맨드 팔레트(10000)보다 위
    'display:flex',
    'align-items:center',
    'justify-content:center',
    // 라이트박스는 사진 감상이 목적이라 팔레트보다 더 짙은 딤을 쓴다.
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'background-color:rgba(0,0,0,.88)',
    'font:14px system-ui,Segoe UI,sans-serif',
    'user-select:none',
    'overflow:hidden',
  ].join(';')

  // 빈 영역(이미지·버튼 바깥) 클릭 시 닫기. 내부 요소는 stopPropagation으로 보호.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeLightbox()
  })

  // 이미지: 화면에 맞춰 보이고(휠 줌으로 확대), 더블클릭으로 줌 리셋.
  const img = document.createElement('img')
  img.alt = ''
  img.draggable = false
  img.style.cssText = [
    'max-width:92vw',
    'max-height:86vh',
    'object-fit:contain',
    'transform-origin:center center',
    'transition:transform .08s ease-out',
    'cursor:zoom-in',
    'box-shadow:0 12px 48px rgba(0,0,0,.6)',
  ].join(';')
  img.addEventListener('mousedown', (e) => e.stopPropagation())
  img.addEventListener('dblclick', (e) => {
    e.preventDefault()
    resetZoom()
  })

  // 휠 줌: 위로 굴리면 확대, 아래로 축소. 페이지 스크롤은 막는다.
  // (백드롭에 걸어 이미지 밖에서 굴려도 동작하게.)
  backdrop.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      setZoom(zoom * factor)
    },
    { passive: false },
  )

  // 이전/다음 버튼(좌우 가장자리에 고정). 화살표 글리프로 표시.
  const prev = makeNavButton('‹', '이전 이미지', 'left')
  prev.addEventListener('click', (e) => {
    e.stopPropagation()
    go(-1)
  })
  const next = makeNavButton('›', '다음 이미지', 'right')
  next.addEventListener('click', (e) => {
    e.stopPropagation()
    go(1)
  })

  // 닫기 버튼(우상단). 명시적 닫기 수단(키/배경 외).
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', '닫기')
  close.textContent = '✕'
  close.style.cssText = [
    'position:absolute',
    'top:16px',
    'right:16px',
    'width:40px',
    'height:40px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border:none',
    'border-radius:50%',
    'cursor:pointer',
    'font-size:20px',
    'line-height:1',
    'background:var(--rb-panel-bg, rgba(40,40,40,.7))',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
  ].join(';')
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    closeLightbox()
  })

  // 캡션(하단 중앙): 제목 + "현재/전체" 순번.
  const caption = document.createElement('div')
  caption.setAttribute('aria-live', 'polite')
  caption.style.cssText = [
    'position:absolute',
    'left:50%',
    'bottom:20px',
    'transform:translateX(-50%)',
    'max-width:80vw',
    'padding:8px 14px',
    'border-radius:10px',
    'text-align:center',
    'font-size:13px',
    'line-height:1.4',
    'background:var(--rb-panel-bg, rgba(40,40,40,.7))',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    '-webkit-backdrop-filter:blur(8px)',
    'backdrop-filter:blur(8px)',
    'pointer-events:none', // 캡션이 빈영역 클릭(닫기)을 가로채지 않게.
  ].join(';')

  backdrop.appendChild(img)
  backdrop.appendChild(prev)
  backdrop.appendChild(next)
  backdrop.appendChild(close)
  backdrop.appendChild(caption)
  document.body.appendChild(backdrop)

  // 키 입력은 캡처 단계에서 가로채 캔버스/문서 단축키와 충돌하지 않게 한다.
  onDocKeydown = handleKeydown
  document.addEventListener('keydown', onDocKeydown, true)

  root = backdrop
  imgEl = img
  captionEl = caption
  prevBtn = prev
  nextBtn = next
}

// 좌/우 가장자리에 붙는 원형 네비 버튼을 만든다(공통 스타일).
function makeNavButton(glyph: string, label: string, side: 'left' | 'right'): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.setAttribute('aria-label', label)
  btn.textContent = glyph
  btn.style.cssText = [
    'position:absolute',
    'top:50%',
    `${side}:16px`,
    'transform:translateY(-50%)',
    'width:48px',
    'height:48px',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border:none',
    'border-radius:50%',
    'cursor:pointer',
    'font-size:30px',
    'line-height:1',
    'background:var(--rb-panel-bg, rgba(40,40,40,.7))',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    '-webkit-backdrop-filter:blur(8px)',
    'backdrop-filter:blur(8px)',
  ].join(';')
  return btn
}

// ---- 표시/네비게이션 ----

// i번째 항목으로 전환한다(이미지 교체 + 캡션 + 줌 리셋 + 버튼 가용성).
function show(i: number): void {
  const item = items[i]
  if (!item || !imgEl) return
  index = i
  imgEl.src = item.src
  resetZoom() // 항목이 바뀌면 줌을 맞춤 상태로 되돌린다.
  updateCaption()
  updateNavButtons()
}

// 캡션 텍스트 갱신: 제목이 있으면 "제목 · n/총", 없으면 "n/총".
function updateCaption(): void {
  if (!captionEl) return
  const item = items[index]
  const pos = `${index + 1} / ${items.length}`
  captionEl.textContent = item?.title ? `${item.title} · ${pos}` : pos
}

// 항목이 1개뿐이면 네비 버튼을 숨긴다(순환은 하지만 UI가 불필요).
function updateNavButtons(): void {
  const many = items.length > 1
  if (prevBtn) prevBtn.style.display = many ? 'flex' : 'none'
  if (nextBtn) nextBtn.style.display = many ? 'flex' : 'none'
}

// 현재 위치에서 delta(-1/+1)만큼 이동(양끝에서 순환).
function go(delta: number): void {
  if (items.length === 0) return
  const n = items.length
  show(((index + delta) % n + n) % n)
}

// startIndex를 유효 범위로 클램프(빈 목록 방어는 호출측에서 함).
function clampIndex(i: number): number {
  if (!Number.isFinite(i)) return 0
  if (i < 0) return 0
  if (i > items.length - 1) return items.length - 1
  return i
}

// ---- 줌 ----

// 줌 배율을 한계 내로 설정하고 transform·커서를 갱신한다.
function setZoom(next: number): void {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  applyZoom()
}

// 줌을 맞춤(1배) 상태로 되돌린다(항목 전환·더블클릭 시).
function resetZoom(): void {
  zoom = 1
  applyZoom()
}

// 현재 zoom 값을 이미지 transform에 반영하고, 확대 여부에 따라 커서를 바꾼다.
function applyZoom(): void {
  if (!imgEl) return
  imgEl.style.transform = `scale(${zoom})`
  imgEl.style.cursor = zoom > 1 ? 'zoom-out' : 'zoom-in'
}

// ---- 키 입력 ----

// 라이트박스 전용 키 처리(캡처 단계). 처리한 키는 캔버스로 새지 않게 막는다.
function handleKeydown(e: KeyboardEvent): void {
  if (!root) return
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      closeLightbox()
      break
    case 'ArrowLeft':
      e.preventDefault()
      e.stopPropagation()
      go(-1)
      break
    case 'ArrowRight':
      e.preventDefault()
      e.stopPropagation()
      go(1)
      break
    default:
      break
  }
}
