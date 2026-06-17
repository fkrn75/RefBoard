import { Scene, type ScenePointer, type Rect } from './core/scene'
import { createEmptyBoard, genId, type BoardImage, type BoardState } from './core/board'
import { Selection } from './core/selection'
import { packImages } from './core/pack'
import { saveBoard, loadBoardFile, pickRefbFile } from './core/io'
import { History } from './core/history'
import { Minimap } from './core/minimap'
import { snapToNeighbors, snapDeltaToGrid, type AABB } from './core/snap'
import { bringToFront, sendToBack, bringForward, sendBackward, normalizeZ } from './core/zorder'

// 앱 진입점: Scene을 만들고 입력(선택/이동/줌/팬/가져오기/단축키)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement

// board는 undo/redo·열기로 통째 교체될 수 있어 let.
let board: BoardState = createEmptyBoard()
const scene = await Scene.create(host)
const sel = new Selection()
const history = new History()
let cam = { ...board.camera }

// 선택이 바뀌면 선택 외곽선 다시 그림
sel.onChange(() => scene.drawSelection(sel.values()))

// ---- UI: 로딩 인디케이터 / 토스트 / 저장상태(dirty) ----
// 화면 중앙 로딩 표시(대용량·다수 이미지 가져올 때)
const loadingEl = document.createElement('div')
loadingEl.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:14px 22px;' +
  'background:rgba(20,20,20,.85);color:#eee;border-radius:10px;font:14px system-ui,sans-serif;' +
  'pointer-events:none;z-index:9999;display:none;box-shadow:0 6px 20px rgba(0,0,0,.5)'
document.body.appendChild(loadingEl)
function showLoading(text: string) {
  loadingEl.textContent = text
  loadingEl.style.display = ''
}
function hideLoading() {
  loadingEl.style.display = 'none'
}

// 하단 토스트(디코드 실패 등 사용자 알림). 기본 경고색, info=true면 중립색.
const toastEl = document.createElement('div')
toastEl.style.cssText =
  'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);padding:10px 18px;' +
  'color:#fff;border-radius:8px;font:13px system-ui,sans-serif;pointer-events:none;' +
  'z-index:9999;opacity:0;transition:opacity .25s;max-width:80vw;text-align:center'
document.body.appendChild(toastEl)
let toastTimer = 0
function showToast(msg: string, info = false) {
  toastEl.textContent = msg
  toastEl.style.background = info ? 'rgba(50,50,55,.92)' : 'rgba(200,60,60,.92)'
  toastEl.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toastEl.style.opacity = '0'), info ? 1600 : 3000)
}

// 저장 안 된 변경 추적: 변경 시 dirty=true → 타이틀 표식 + 새로고침 경고
let dirty = false
function setDirty(v: boolean) {
  if (dirty === v) return
  dirty = v
  document.title = (dirty ? '● ' : '') + 'RefBoard'
}
// 보드를 바꾸는 동작의 표준 진입점: 직전 상태를 히스토리에 적재 + dirty 표시
function commit() {
  history.push(board)
  setDirty(true)
}
window.addEventListener('beforeunload', (e) => {
  if (!dirty) return
  e.preventDefault()
  e.returnValue = '' // 일부 브라우저는 반환값이 있어야 경고 표시
})

// ---- 미니맵 / 스냅 ----
const minimap = new Minimap(host)
minimap.setVisible(false) // 기본 숨김(M 키로 토글)
let snapOn = false // 스냅(그리드·이웃) 토글 (N 키)
function updateMinimap() {
  minimap.update(scene.contentBounds(), cam, host.clientWidth, host.clientHeight)
}
// 미니맵 클릭 → 그 월드점을 화면 중앙으로 이동
minimap.onJump = (wx, wy) => {
  cam.x = host.clientWidth / 2 - wx * cam.zoom
  cam.y = host.clientHeight / 2 - wy * cam.zoom
  applyCam()
}

// ---- 카메라 ----
function applyCam() {
  scene.setCamera(cam.x, cam.y, cam.zoom)
  board.camera = { ...cam }
  scene.drawSelection(sel.values()) // 줌 변화에 맞춰 외곽선 두께(줌 보정) 갱신
  updateMinimap()
}
applyCam()

// 주어진 월드 경계(AABB)가 화면에 꽉 차도록 카메라를 맞춘다(pad<1 이면 여백).
function fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, pad = 0.9) {
  const W = host.clientWidth
  const H = host.clientHeight
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  const scale = Math.min(20, Math.max(0.05, Math.min(W / bw, H / bh) * pad))
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  cam.zoom = scale
  cam.x = W / 2 - cx * scale
  cam.y = H / 2 - cy * scale
  applyCam()
}

// 전체 보기(Ctrl+Space): 모든 아이템이 보이게 맞춤
function fitAll() {
  const b = scene.contentBounds()
  if (b) fitBounds(b)
}

// 선택(없으면 첫) 이미지에 포커스(Space)
function focusSelected() {
  const id = sel.values()[0] ?? scene.allIds()[0]
  if (!id) return
  const a = scene.getItemAABB(id)
  if (a) fitBounds(a, 0.8)
}

// 줌 100% 리셋(Ctrl+0): 화면 중심의 월드점을 유지하며 배율만 1로
function zoomReset() {
  const W = host.clientWidth
  const H = host.clientHeight
  const cw = scene.screenToWorld(W / 2, H / 2)
  cam.zoom = 1
  cam.x = W / 2 - cw.x
  cam.y = H / 2 - cw.y
  applyCam()
}

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
// 더블클릭: 그 아래 이미지에 포커스(없으면 전체 보기)
host.addEventListener('dblclick', () => {
  if (sel.size > 0 || scene.allIds().length > 0) focusSelected()
})

// ---- 선택 + 이동 + 러버밴드 (PixiJS 좌클릭 이벤트) ----
type DragState =
  | {
      mode: 'move'
      start: { x: number; y: number }
      origins: Map<string, { x: number; y: number }>
      committed: boolean
      others: AABB[] // 스냅 타깃(선택 안 된 다른 아이템 AABB), 드래그 시작 시 1회 캐시
    }
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
    // 스냅 타깃: 이동하지 않는(선택 외) 아이템들의 AABB를 시작 시 1회 캐시(매 move 재계산 비용 방지)
    const others: AABB[] = []
    for (const id of scene.allIds()) {
      if (origins.has(id)) continue
      const a = scene.getItemAABB(id)
      if (a) others.push(a)
    }
    drag = { mode: 'move', start: p.world, origins, committed: false, others }
    // 이동 드래그 동안 커서를 grabbing으로(캔버스 전체 + 스프라이트)
    host.style.cursor = 'grabbing'
    scene.setCursor('grabbing')
  } else {
    if (!p.shift) sel.clear()
    drag = { mode: 'rubber', start: p.world, additive: p.shift }
  }
}

scene.onPointerMove = (p: ScenePointer) => {
  if (!drag) return
  if (drag.mode === 'move') {
    let dx = p.world.x - drag.start.x
    let dy = p.world.y - drag.start.y
    // Shift = 축 고정(수평/수직 중 더 많이 움직인 축만)
    if (p.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0
      else dx = 0
    }
    // 실제 이동이 처음 발생할 때 1회만 히스토리에 기록(클릭만으로는 기록 안 함)
    if (!drag.committed && (dx !== 0 || dy !== 0)) {
      commit()
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
    // 스냅(켜졌을 때): 대표(첫 선택) 아이템 기준 보정량을 전 선택에 동일 적용. 이웃 우선, 없으면 그리드.
    if (snapOn && drag.origins.size > 0) {
      const repId = [...drag.origins.keys()][0]
      const a = scene.getItemAABB(repId)
      if (a) {
        const thr = 8 / cam.zoom // 화면 8px를 월드 단위로
        let adj = snapToNeighbors(a, drag.others, thr)
        if (adj.dx === 0 && adj.dy === 0) adj = snapDeltaToGrid(a.minX, a.minY, 32) // 이웃 없으면 32px 그리드
        if (adj.dx !== 0 || adj.dy !== 0) {
          for (const [id, o] of drag.origins) {
            const img = board.items.find((i) => i.id === id)
            if (!img) continue
            img.transform.x = o.x + dx + adj.dx
            img.transform.y = o.y + dy + adj.dy
            const s = scene.getSprite(id)
            if (s) scene.applyTransform(s, img)
          }
        }
      }
    }
    scene.drawSelection(sel.values())
    updateMinimap()
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
  } else if (drag.mode === 'move') {
    // 이동 종료 → 커서 복원(빈 곳=기본, 스프라이트 hover=grab)
    host.style.cursor = ''
    scene.setCursor('grab')
    updateMinimap()
  }
  drag = null
}

function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// ---- 동작: 삭제 / 복제 / 자동 패킹 / z순서 / 저장 / 열기 / Undo / Redo ----

// 선택 삭제 (Del/Backspace)
function deleteSelected() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    scene.removeImage(id)
    const idx = board.items.findIndex((i) => i.id === id)
    if (idx >= 0) board.items.splice(idx, 1)
  }
  normalizeZ(board.items) // 삭제로 생긴 빈 z 정리(빈틈없는 연속 정수)
  syncZIndex()
  sel.clear()
  updateMinimap()
  if (board.items.length === 0) hint.style.display = ''
}

// 선택 복제 (Ctrl+D) — 깊은 복제 + 새 id + 살짝 어긋난 위치
async function duplicateSelected() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
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
  updateMinimap()
}

// 자동 패킹 (Ctrl+P) — 선택 2개 이상이면 선택만, 아니면 전체. 패킹 후 전체 보기.
function packAll() {
  const targets = sel.size > 1 ? sel.values() : scene.allIds()
  if (targets.length < 2) return
  commit()
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
  fitAll() // 패킹 결과가 화면에 꽉 차게(내부 applyCam이 미니맵도 갱신)
}

// z순서 변경의 공통 처리: 히스토리 적재 → 모듈 호출 → 각 스프라이트 zIndex 동기화
function applyZOrder(fn: (items: BoardImage[], ids: Set<string> | string[]) => void) {
  if (sel.size === 0) return
  commit()
  fn(board.items, sel.values())
  syncZIndex()
}
// board.items[].z → 스프라이트 zIndex 반영(world.sortableChildren로 재정렬)
function syncZIndex() {
  for (const im of board.items) {
    const s = scene.getSprite(im.id)
    if (s) s.zIndex = im.z
  }
}

// 파일 열기 다이얼로그로 이미지 가져오기 (Ctrl+I)
function openImageFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.onchange = async () => {
    const files = [...(input.files ?? [])]
    const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
    await importFiles(files, center.x, center.y)
  }
  input.click()
}

// 보드 열기 (Ctrl+O)
async function openBoard() {
  const file = await pickRefbFile()
  if (!file) return
  try {
    const state = await loadBoardFile(file)
    history.push(board) // 열기 직전 상태도 undo 가능하게
    await restore(state)
    setDirty(false) // 방금 연 파일 = 저장된 상태
  } catch (err) {
    showToast(err instanceof Error ? err.message : '파일 열기 실패')
  }
}

// Undo / Redo — 현재 상태를 넘겨 반대편 스택에 보존
async function doUndo() {
  const prev = history.undo(board)
  if (prev) {
    await restore(prev)
    setDirty(true) // 되돌림도 저장 안 된 변경
  }
}
async function doRedo() {
  const next = history.redo(board)
  if (next) {
    await restore(next)
    setDirty(true)
  }
}

// 저장: .refb 다운로드 후 dirty 해제
function save() {
  saveBoard(board)
  setDirty(false)
}

// ---- 키보드 단축키 ----
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (e.key === ' ') {
    // Ctrl+Space = 전체 보기, Space = 선택 이미지 포커스
    e.preventDefault()
    if (ctrl) fitAll()
    else focusSelected()
  } else if (ctrl && k === 'a') {
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
  } else if (ctrl && k === 'i') {
    e.preventDefault()
    openImageFiles()
  } else if (ctrl && k === '0') {
    e.preventDefault()
    zoomReset()
  } else if (ctrl && k === 's') {
    e.preventDefault()
    save()
  } else if (ctrl && k === 'o') {
    e.preventDefault()
    void openBoard()
  } else if (ctrl && !e.shiftKey && k === 'z') {
    e.preventDefault()
    void doUndo()
  } else if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
    e.preventDefault()
    void doRedo()
  } else if (e.code === 'BracketRight') {
    // ] = 한 단계 앞, Shift+] = 맨 앞
    e.preventDefault()
    applyZOrder(e.shiftKey ? bringToFront : bringForward)
  } else if (e.code === 'BracketLeft') {
    // [ = 한 단계 뒤, Shift+[ = 맨 뒤
    e.preventDefault()
    applyZOrder(e.shiftKey ? sendToBack : sendBackward)
  } else if (!ctrl && k === 'm') {
    // 미니맵 토글
    minimap.toggle()
    updateMinimap()
  } else if (!ctrl && k === 'n') {
    // 스냅(그리드·이웃) 토글
    snapOn = !snapOn
    showToast(snapOn ? '스냅 켜짐 · 그리드/이웃' : '스냅 꺼짐', true)
  }
})

// ---- 가져오기 공통: 파일 다수 → 로딩 표시 + 개별 디코드 에러 토스트 + 1 undo 묶음 ----
async function importFiles(files: File[], baseX: number, baseY: number) {
  if (files.length === 0) return
  // 1단계: 디코드 검증(원본 크기 측정). 실패한 파일은 건너뜀.
  const valid: { url: string; size: { w: number; h: number } }[] = []
  let failed = 0
  for (let i = 0; i < files.length; i++) {
    showLoading(files.length > 1 ? `이미지 불러오는 중… ${i + 1}/${files.length}` : '이미지 불러오는 중…')
    try {
      const url = await fileToDataURL(files[i])
      const size = await imageSize(url)
      valid.push({ url, size })
    } catch {
      failed++
    }
  }
  // 2단계: 유효한 것만 한 묶음(1 undo)으로 추가
  if (valid.length > 0) {
    commit()
    for (let j = 0; j < valid.length; j++) {
      if (valid.length > 1) showLoading(`배치 중… ${j + 1}/${valid.length}`)
      await placeImageWithSize(valid[j].url, valid[j].size, baseX + j * 30, baseY + j * 30)
    }
    updateMinimap()
  }
  hideLoading()
  if (failed > 0) {
    showToast(`${failed}개 이미지를 불러오지 못했습니다${valid.length > 0 ? ` · ${valid.length}개 추가됨` : ''}`)
  }
}

// ---- 가져오기: 드래그앤드롭 ----
host.addEventListener('dragover', (e) => e.preventDefault())
host.addEventListener('drop', async (e) => {
  e.preventDefault()
  if (!e.dataTransfer) return
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  const rect = host.getBoundingClientRect()
  const at = scene.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
  await importFiles(files, at.x, at.y)
})

// ---- 가져오기: 클립보드 붙여넣기 ----
window.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items
  if (!items) return
  const files = [...items]
    .filter((it) => it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null)
  if (files.length === 0) return
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  await importFiles(files, center.x, center.y)
})

// 크기를 미리 알 때(importFiles가 사전 검증한 경우) 중복 디코드 없이 추가
async function placeImageWithSize(dataUrl: string, size: { w: number; h: number }, x: number, y: number) {
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
  minimap,
  packAll,
  deleteSelected,
  duplicateSelected,
  fitAll,
  focusSelected,
  zoomReset,
  bringToFront: () => applyZOrder(bringToFront),
  sendToBack: () => applyZOrder(sendToBack),
  toggleSnap: () => ((snapOn = !snapOn), snapOn),
  toggleMinimap: () => (minimap.toggle(), updateMinimap()),
  undo: doUndo,
  redo: doRedo,
  save,
  getItem: (id: string) => board.items.find((i) => i.id === id),
}
