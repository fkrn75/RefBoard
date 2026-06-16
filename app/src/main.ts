import { Scene, type ScenePointer, type Rect } from './core/scene'
import { createEmptyBoard, genId, type BoardImage } from './core/board'
import { Selection } from './core/selection'

// 앱 진입점: Scene을 만들고 입력(선택/이동/줌/팬/가져오기)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement

const board = createEmptyBoard()
const scene = await Scene.create(host)
const sel = new Selection()

// 선택이 바뀌면 선택 외곽선 다시 그림
sel.onChange(() => scene.drawSelection(sel.values()))

// ---- 카메라 ----
const cam = { ...board.camera }
function applyCam() {
  scene.setCamera(cam.x, cam.y, cam.zoom)
  board.camera = { ...cam }
  scene.drawSelection(sel.values()) // 줌 변화에 맞춰 외곽선 두께(줌 보정) 갱신
}
applyCam()

// ---- 줌: 휠(커서 위치를 고정점으로) ----
host.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const newZoom = Math.min(20, Math.max(0.05, cam.zoom * factor))
    const rect = host.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    cam.x = mx - (mx - cam.x) * (newZoom / cam.zoom)
    cam.y = my - (my - cam.y) * (newZoom / cam.zoom)
    cam.zoom = newZoom
    applyCam()
  },
  { passive: false },
)

// ---- 팬: 우클릭/휠클릭 드래그 (DOM 이벤트) ----
let panning = false
let last = { x: 0, y: 0 }
host.addEventListener('pointerdown', (e) => {
  if (e.button === 2 || e.button === 1) {
    panning = true
    last = { x: e.clientX, y: e.clientY }
    host.setPointerCapture(e.pointerId)
  }
})
host.addEventListener('pointermove', (e) => {
  if (!panning) return
  cam.x += e.clientX - last.x
  cam.y += e.clientY - last.y
  last = { x: e.clientX, y: e.clientY }
  applyCam()
})
host.addEventListener('pointerup', (e) => {
  if (panning) {
    panning = false
    host.releasePointerCapture(e.pointerId)
  }
})
host.addEventListener('contextmenu', (e) => e.preventDefault()) // 우클릭 메뉴 차단(팬에 사용)

// ---- 선택 + 이동 + 러버밴드 (PixiJS 좌클릭 이벤트) ----
type DragState =
  | { mode: 'move'; start: { x: number; y: number }; origins: Map<string, { x: number; y: number }> }
  | { mode: 'rubber'; start: { x: number; y: number }; additive: boolean }
  | null
let drag: DragState = null

scene.onPointerDown = (p: ScenePointer) => {
  if (p.button !== 0) return // 좌클릭만 (우클릭은 팬)
  if (p.hitId) {
    // 아이템 클릭 → 선택 결정
    if (p.shift) sel.toggle(p.hitId)
    else if (!sel.has(p.hitId)) sel.set([p.hitId]) // 이미 선택된 것 다시 클릭 시 유지(다중 이동 대비)
    // 선택된 아이템들의 시작 위치 기록 → 이동 준비 (잠긴 항목 제외)
    const origins = new Map<string, { x: number; y: number }>()
    for (const id of sel.values()) {
      const img = board.items.find((i) => i.id === id)
      if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
    }
    drag = { mode: 'move', start: p.world, origins }
  } else {
    // 빈 곳 클릭 → (Shift 아니면) 해제 후 러버밴드 시작
    if (!p.shift) sel.clear()
    drag = { mode: 'rubber', start: p.world, additive: p.shift }
  }
}

scene.onPointerMove = (p: ScenePointer) => {
  if (!drag) return
  if (drag.mode === 'move') {
    const dx = p.world.x - drag.start.x
    const dy = p.world.y - drag.start.y
    for (const [id, o] of drag.origins) {
      const img = board.items.find((i) => i.id === id)
      if (!img) continue
      img.transform.x = o.x + dx
      img.transform.y = o.y + dy
      const s = scene.getSprite(id)
      if (s) scene.applyTransform(s, img)
    }
    scene.drawSelection(sel.values()) // 외곽선도 함께 이동
  } else {
    scene.drawRubber(rectOf(drag.start, p.world))
  }
}

scene.onPointerUp = (p: ScenePointer) => {
  if (!drag) return
  if (drag.mode === 'rubber') {
    const r = rectOf(drag.start, p.world)
    const hits = scene.allIds().filter((id) => {
      const a = scene.getItemAABB(id)
      return a !== null && !(a.maxX < r.x || a.minX > r.x + r.w || a.maxY < r.y || a.minY > r.y + r.h)
    })
    if (drag.additive) for (const id of hits) sel.add(id)
    else sel.set(hits)
    scene.drawRubber(null)
  }
  drag = null
}

// 두 점으로 정규화된 사각형(좌상단 + 너비/높이)
function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// ---- 키보드 ----
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault()
    sel.set(scene.allIds()) // 전체 선택
  } else if (e.key === 'Escape') {
    sel.clear()
    scene.drawRubber(null)
    drag = null
  }
})

// ---- 가져오기: 드래그앤드롭 ----
host.addEventListener('dragover', (e) => e.preventDefault())
host.addEventListener('drop', async (e) => {
  e.preventDefault()
  if (!e.dataTransfer) return
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
  const rect = host.getBoundingClientRect()
  const at = scene.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  let offset = 0
  for (const file of files) {
    await placeImage(await fileToDataURL(file), at.x + offset, at.y + offset)
    offset += 30 // 여러 장은 살짝 어긋나게
  }
})

// ---- 가져오기: 클립보드 붙여넣기 ----
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items
  if (!items) return
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  for (const it of items) {
    if (!it.type.startsWith('image/')) continue
    const file = it.getAsFile()
    if (file) await placeImage(await fileToDataURL(file), center.x, center.y)
  }
})

// 보드에 이미지 한 장 추가(데이터 모델 + 렌더 동시)
async function placeImage(dataUrl: string, x: number, y: number) {
  const size = await imageSize(dataUrl)
  const img: BoardImage = {
    id: genId(),
    type: 'image',
    src: dataUrl,
    natural: size,
    transform: { x, y, scale: 1, rotation: 0 },
    opacity: 1,
    locked: false,
    z: board.items.length,
  }
  board.items.push(img)
  await scene.addImage(img)
  hint.style.display = 'none'
}

// ---- 유틸 ----
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
function imageSize(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = () => reject(new Error('이미지 로드 실패'))
    im.src = src
  })
}

// 디버그용 전역 노출(콘솔에서 refboard.board / refboard.sel 확인 가능)
;(globalThis as unknown as { refboard: unknown }).refboard = { board, scene, sel }
