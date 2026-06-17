import { Scene, type ScenePointer, type Rect } from './core/scene'
import { createEmptyBoard, genId, type BoardImage, type BoardState } from './core/board'
import { Selection } from './core/selection'
import { packImages } from './core/pack'
import { saveBoard, loadBoardFile, pickRefbFile } from './core/io'
import { History } from './core/history'

// 앱 진입점: Scene을 만들고 입력(선택/이동/줌/팬/가져오기/단축키)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement

// board는 undo/redo·열기로 통째 교체될 수 있어 let.
let board: BoardState = createEmptyBoard()
const scene = await Scene.create(host)
const sel = new Selection()
const history = new History()

// 선택이 바뀌면 선택 외곽선 다시 그림
sel.onChange(() => scene.drawSelection(sel.values()))

// ---- 카메라 ----
let cam = { ...board.camera }
function applyCam() {
  scene.setCamera(cam.x, cam.y, cam.zoom)
  board.camera = { ...cam }
  scene.drawSelection(sel.values()) // 줌 변화에 맞춰 외곽선 두께(줌 보정) 갱신
}
applyCam()

// 보드 통째 복원(열기·undo·redo 공용): 렌더 재구성 + 카메라/선택/힌트 동기화
async function restore(state: BoardState) {
  board = state
  await scene.rebuild(board.items)
  cam = { ...board.camera }
  applyCam()
  sel.clear()
  hint.style.display = board.items.length > 0 ? 'none' : ''
}

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
host.addEventListener('contextmenu', (e) => e.preventDefault())

// ---- 선택 + 이동 + 러버밴드 (PixiJS 좌클릭 이벤트) ----
type DragState =
  | { mode: 'move'; start: { x: number; y: number }; origins: Map<string, { x: number; y: number }>; committed: boolean }
  | { mode: 'rubber'; start: { x: number; y: number }; additive: boolean }
  | null
let drag: DragState = null

scene.onPointerDown = (p: ScenePointer) => {
  if (p.button !== 0) return // 좌클릭만 (우클릭은 팬)
  if (p.hitId) {
    if (p.shift) sel.toggle(p.hitId)
    else if (!sel.has(p.hitId)) sel.set([p.hitId])
    const origins = new Map<string, { x: number; y: number }>()
    for (const id of sel.values()) {
      const img = board.items.find((i) => i.id === id)
      if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
    }
    drag = { mode: 'move', start: p.world, origins, committed: false }
  } else {
    if (!p.shift) sel.clear()
    drag = { mode: 'rubber', start: p.world, additive: p.shift }
  }
}

scene.onPointerMove = (p: ScenePointer) => {
  if (!drag) return
  if (drag.mode === 'move') {
    const dx = p.world.x - drag.start.x
    const dy = p.world.y - drag.start.y
    // 실제 이동이 처음 발생할 때 1회만 히스토리에 기록(클릭만으로는 기록 안 함)
    if (!drag.committed && (dx !== 0 || dy !== 0)) {
      history.push(board)
      drag.committed = true
    }
    for (const [id, o] of drag.origins) {
      const img = board.items.find((i) => i.id === id)
      if (!img) continue
      img.transform.x = o.x + dx
      img.transform.y = o.y + dy
      const s = scene.getSprite(id)
      if (s) scene.applyTransform(s, img)
    }
    scene.drawSelection(sel.values())
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

function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// ---- 동작: 삭제 / 복제 / 자동 패킹 / 저장 / 열기 / Undo / Redo ----

// 선택 삭제 (Del/Backspace)
function deleteSelected() {
  const ids = sel.values()
  if (ids.length === 0) return
  history.push(board)
  for (const id of ids) {
    scene.removeImage(id)
    const idx = board.items.findIndex((i) => i.id === id)
    if (idx >= 0) board.items.splice(idx, 1)
  }
  sel.clear()
  if (board.items.length === 0) hint.style.display = ''
}

// 선택 복제 (Ctrl+D) — 깊은 복제 + 새 id + 살짝 어긋난 위치
async function duplicateSelected() {
  const ids = sel.values()
  if (ids.length === 0) return
  history.push(board)
  const newIds: string[] = []
  for (const id of ids) {
    const src = board.items.find((i) => i.id === id)
    if (!src) continue
    const copy = structuredClone(src) as BoardImage
    copy.id = genId()
    copy.z = board.items.length
    copy.transform.x += 24
    copy.transform.y += 24
    board.items.push(copy)
    await scene.addImage(copy)
    newIds.push(copy.id)
  }
  sel.set(newIds)
}

// 자동 패킹 (Ctrl+P) — 선택 2개 이상이면 선택만, 아니면 전체. 현재 뷰 중앙에 배치.
function packAll() {
  const targets = sel.size > 1 ? sel.values() : scene.allIds()
  if (targets.length < 2) return
  history.push(board)
  const items = targets.map((id) => {
    const im = board.items.find((i) => i.id === id)!
    return { id, w: im.natural.w * im.transform.scale, h: im.natural.h * im.transform.scale }
  })
  const aspect = Math.max(0.1, host.clientWidth / host.clientHeight)
  const pos = packImages(items, { aspect, padding: 16 })
  // packImages는 바운딩 중심이 원점(0,0)인 중심 좌표를 반환 → 현재 뷰 중앙(월드)으로 평행이동
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  for (const id of targets) {
    const im = board.items.find((i) => i.id === id)
    const p = pos.get(id)
    if (!im || !p) continue
    im.transform.x = center.x + p.x
    im.transform.y = center.y + p.y
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, im)
  }
  scene.drawSelection(sel.values())
}

// 열기 (Ctrl+O)
async function openBoard() {
  const file = await pickRefbFile()
  if (!file) return
  try {
    const state = await loadBoardFile(file)
    history.push(board) // 열기 직전 상태도 undo 가능하게
    await restore(state)
  } catch (err) {
    alert(err instanceof Error ? err.message : '파일 열기 실패')
  }
}

// Undo / Redo — 현재 상태를 넘겨 반대편 스택에 보존
async function doUndo() {
  const prev = history.undo(board)
  if (prev) await restore(prev)
}
async function doRedo() {
  const next = history.redo(board)
  if (next) await restore(next)
}

// ---- 키보드 단축키 ----
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (ctrl && k === 'a') {
    e.preventDefault()
    sel.set(scene.allIds())
  } else if (e.key === 'Escape') {
    sel.clear()
    scene.drawRubber(null)
    drag = null
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected()
  } else if (ctrl && k === 'd') {
    e.preventDefault()
    void duplicateSelected()
  } else if (ctrl && k === 'p') {
    e.preventDefault()
    packAll()
  } else if (ctrl && k === 's') {
    e.preventDefault()
    saveBoard(board)
  } else if (ctrl && k === 'o') {
    e.preventDefault()
    void openBoard()
  } else if (ctrl && !e.shiftKey && k === 'z') {
    e.preventDefault()
    void doUndo()
  } else if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
    e.preventDefault()
    void doRedo()
  }
})

// ---- 가져오기: 드래그앤드롭 ----
host.addEventListener('dragover', (e) => e.preventDefault())
host.addEventListener('drop', async (e) => {
  e.preventDefault()
  if (!e.dataTransfer) return
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  history.push(board) // 추가 직전 1회(드롭 묶음 = 1 undo)
  const rect = host.getBoundingClientRect()
  const at = scene.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  let offset = 0
  for (const file of files) {
    await placeImage(await fileToDataURL(file), at.x + offset, at.y + offset)
    offset += 30
  }
})

// ---- 가져오기: 클립보드 붙여넣기 ----
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items
  if (!items) return
  const imgs = [...items].filter((it) => it.type.startsWith('image/'))
  if (imgs.length === 0) return
  history.push(board)
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  for (const it of imgs) {
    const file = it.getAsFile()
    if (file) await placeImage(await fileToDataURL(file), center.x, center.y)
  }
})

// 보드에 이미지 한 장 추가(데이터 모델 + 렌더). 히스토리 push는 호출측(drop/paste)이 담당.
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

// 디버그용 전역 노출(board는 let이라 getter로 최신 참조 반환)
;(globalThis as unknown as { refboard: unknown }).refboard = {
  get board() {
    return board
  },
  scene,
  sel,
  history,
  packAll,
  deleteSelected,
  duplicateSelected,
  undo: doUndo,
  redo: doRedo,
  save: () => saveBoard(board),
  getItem: (id: string) => board.items.find((i) => i.id === id),
}
