import { Scene, type ScenePointer, type Rect } from './core/scene'
import { createEmptyBoard, genId, type BoardImage, type BoardState, type Transform } from './core/board'
import { Selection } from './core/selection'
import { packImages } from './core/pack'
import { saveBoard, loadBoardFile, pickRefbFile } from './core/io'
import { History } from './core/history'
import { Minimap } from './core/minimap'
import { snapToNeighbors, snapDeltaToGrid, type AABB } from './core/snap'
import { bringToFront, sendToBack, bringForward, sendBackward, normalizeZ } from './core/zorder'
import { alignEdge, distribute, normalizeSize, type AlignItem } from './core/align'
import { handlePositions, hitTest, scaleFromHandle, rotateFromPointer, type HandleId } from './core/gizmo'
import { cropRectFromDrag } from './core/crop'
import { expandByGroup, planGroup, planUngroup } from './core/group'
import { visibleGrid } from './core/grid'
import { OpacityControl } from './core/opacity-control'

// 앱 진입점: Scene을 만들고 입력(선택/이동/변형/줌/팬/가져오기/단축키)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement

// board는 undo/redo·열기로 통째 교체될 수 있어 let.
let board: BoardState = createEmptyBoard()
const scene = await Scene.create(host)
const sel = new Selection()
const history = new History()
let cam = { ...board.camera }

// 선택이 바뀌면 선택 외곽선 + 기즈모 + 투명도 패널 다시 그림
sel.onChange(() => {
  scene.drawSelection(sel.values(), lockedIdSet())
  refreshGizmo()
  syncOpacityControl()
})

// ---- UI: 로딩 인디케이터 / 토스트 / 저장상태(dirty) ----
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
  e.returnValue = ''
})

// ---- 미니맵 / 스냅 / 그리드 / 투명도 ----
const minimap = new Minimap(host)
minimap.setVisible(false)
let snapOn = false
let gridOn = false

// 잠긴 아이템 id 집합(선택 외곽선 색 구분용)
function lockedIdSet(): Set<string> {
  const s = new Set<string>()
  for (const im of board.items) if (im.locked) s.add(im.id)
  return s
}

// 투명도 슬라이더(우상단). 드래그=실시간 미리보기(첫 입력에 1회 commit), 놓으면 확정.
const opacityCtl = new OpacityControl(host)
let opacityCommitted = false
opacityCtl.onInput = (v) => {
  const ids = sel.values()
  if (ids.length === 0) return
  if (!opacityCommitted) {
    commit() // 드래그 직전 상태를 1회만 히스토리에 적재(undo 1스텝)
    opacityCommitted = true
  }
  for (const id of ids) {
    const im = board.items.find((i) => i.id === id)
    if (!im) continue
    im.opacity = v
    const s = scene.getSprite(id)
    if (s) s.alpha = v
  }
}
opacityCtl.onChange = () => {
  opacityCommitted = false // 다음 드래그를 위해 리셋(값은 onInput이 이미 반영)
}
// 선택에 맞춰 투명도 패널 표시/숨김 + 대표값(첫 항목) 동기화
function syncOpacityControl() {
  const ids = sel.values()
  if (ids.length === 0) {
    opacityCtl.hide()
    return
  }
  const im = board.items.find((i) => i.id === ids[0])
  opacityCtl.show(im ? im.opacity : 1)
}
function updateMinimap() {
  minimap.update(scene.contentBounds(), cam, host.clientWidth, host.clientHeight)
}
minimap.onJump = (wx, wy) => {
  cam.x = host.clientWidth / 2 - wx * cam.zoom
  cam.y = host.clientHeight / 2 - wy * cam.zoom
  applyCam()
}

// 단일 선택일 때만 변형 기즈모 핸들 표시(다중/0/잠금은 숨김)
function refreshGizmo() {
  const ids = sel.values()
  if (ids.length === 1) {
    const im = board.items.find((i) => i.id === ids[0])
    if (im && !im.locked) {
      scene.drawGizmo(handlePositions(im.transform, im.natural, 30 / cam.zoom))
      return
    }
  }
  scene.drawGizmo([])
}

// 편집(이동/변형/정렬) 후 공통 갱신: 선택외곽선 + 기즈모 + 미니맵
function afterEdit() {
  scene.drawSelection(sel.values(), lockedIdSet())
  refreshGizmo()
  updateMinimap()
}

// ---- 카메라 ----
function applyCam() {
  scene.setCamera(cam.x, cam.y, cam.zoom)
  board.camera = { ...cam }
  scene.drawSelection(sel.values(), lockedIdSet()) // 줌 변화에 맞춰 외곽선 두께(줌 보정) 갱신
  refreshGizmo() // 핸들 크기/오프셋도 줌 보정
  updateMinimap()
  drawGridIfOn() // 그리드도 보이는 영역 기준 재계산
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

function fitAll() {
  const b = scene.contentBounds()
  if (b) fitBounds(b)
}

function focusSelected() {
  const id = sel.values()[0] ?? scene.allIds()[0]
  if (!id) return
  const a = scene.getItemAABB(id)
  if (a) fitBounds(a, 0.8)
}

function zoomReset() {
  const W = host.clientWidth
  const H = host.clientHeight
  const cw = scene.screenToWorld(W / 2, H / 2)
  cam.zoom = 1
  cam.x = W / 2 - cw.x
  cam.y = H / 2 - cw.y
  applyCam()
}

// 보드 통째 복원(열기·undo·redo 공용)
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
host.addEventListener('dblclick', () => {
  if (sel.size > 0 || scene.allIds().length > 0) focusSelected()
})

// ---- 선택 + 이동 + 러버밴드 + 기즈모 변형 (PixiJS 좌클릭 이벤트) ----
type DragState =
  | {
      mode: 'move'
      start: { x: number; y: number }
      origins: Map<string, { x: number; y: number }>
      committed: boolean
      others: AABB[]
    }
  | { mode: 'rubber'; start: { x: number; y: number }; additive: boolean }
  | { mode: 'gizmo'; handle: HandleId; id: string; t0: Transform; start: { x: number; y: number }; committed: boolean }
  | null
let drag: DragState = null

scene.onPointerDown = (p: ScenePointer) => {
  if (p.button !== 0) return // 좌클릭만 (우클릭은 팬)
  // 0) 크롭 모드: 대상 이미지 기준 드래그 시작점(원본픽셀) 기록
  if (cropMode && cropTargetId) {
    const im = board.items.find((i) => i.id === cropTargetId)
    if (im) {
      cropDrag = { startPix: worldToPixel(im, p.world.x, p.world.y), startWorld: p.world }
      return
    }
  }
  // 1) 변형 기즈모 핸들 우선 판정(단일 선택·비잠금)
  if (sel.size === 1) {
    const gid = sel.values()[0]
    const gim = board.items.find((i) => i.id === gid)
    if (gim && !gim.locked) {
      const handles = handlePositions(gim.transform, gim.natural, 30 / cam.zoom)
      const hit = hitTest(p.world, handles, 9 / cam.zoom)
      if (hit) {
        drag = { mode: 'gizmo', handle: hit, id: gid, t0: { ...gim.transform }, start: p.world, committed: false }
        host.style.cursor = hit === 'rotate' ? 'grabbing' : 'nwse-resize'
        return
      }
    }
  }
  // 2) 이미지 선택 + 이동 (그룹 멤버 클릭 시 그룹 통째 선택)
  if (p.hitId) {
    if (p.shift) sel.toggle(p.hitId)
    else if (!sel.has(p.hitId)) sel.set(expandByGroup(board.items, [p.hitId]))
    const origins = new Map<string, { x: number; y: number }>()
    for (const id of sel.values()) {
      const img = board.items.find((i) => i.id === id)
      if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
    }
    const others: AABB[] = []
    for (const id of scene.allIds()) {
      if (origins.has(id)) continue
      const a = scene.getItemAABB(id)
      if (a) others.push(a)
    }
    drag = { mode: 'move', start: p.world, origins, committed: false, others }
    host.style.cursor = 'grabbing'
    scene.setCursor('grabbing')
  } else {
    // 3) 빈 곳 → 러버밴드
    if (!p.shift) sel.clear()
    drag = { mode: 'rubber', start: p.world, additive: p.shift }
  }
}

scene.onPointerMove = (p: ScenePointer) => {
  // 크롭 모드: 드래그 사각형 미리보기(월드 좌표)
  if (cropMode) {
    if (cropDrag) scene.drawRubber(rectOf(cropDrag.startWorld, p.world))
    return
  }
  if (!drag) return
  if (drag.mode === 'gizmo') {
    const gd = drag // 타입 내로잉 캡처(아래 콜백/commit 이후에도 'gizmo'로 고정)
    const im = board.items.find((i) => i.id === gd.id)
    if (!im) return
    if (!gd.committed) {
      commit()
      gd.committed = true
    }
    if (gd.handle === 'rotate') {
      im.transform.rotation = rotateFromPointer(gd.t0, gd.start, p.world, p.shift).rotation
    } else {
      const r = scaleFromHandle(gd.handle, gd.t0, im.natural, gd.start, p.world, { centered: p.alt })
      im.transform.scale = r.scale
      im.transform.x = r.x
      im.transform.y = r.y
    }
    const s = scene.getSprite(gd.id)
    if (s) scene.applyTransform(s, im)
    afterEdit()
    return
  }
  if (drag.mode === 'move') {
    let dx = p.world.x - drag.start.x
    let dy = p.world.y - drag.start.y
    if (p.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0
      else dx = 0
    }
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
    // 스냅(켜졌을 때): 대표(첫) 아이템 기준 보정량을 전 선택에 적용. 이웃 우선→그리드.
    if (snapOn && drag.origins.size > 0) {
      const repId = [...drag.origins.keys()][0]
      const a = scene.getItemAABB(repId)
      if (a) {
        const thr = 8 / cam.zoom
        let adj = snapToNeighbors(a, drag.others, thr)
        if (adj.dx === 0 && adj.dy === 0) adj = snapDeltaToGrid(a.minX, a.minY, 32)
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
    afterEdit()
  } else if (drag.mode === 'rubber') {
    scene.drawRubber(rectOf(drag.start, p.world))
  }
}

scene.onPointerUp = (p: ScenePointer) => {
  // 크롭 모드: 드래그 영역을 원본픽셀 크롭으로 확정(크롭 영역은 제자리 유지)
  if (cropMode) {
    if (cropDrag && cropTargetId) {
      const im = board.items.find((i) => i.id === cropTargetId)
      if (im) {
        const endPix = worldToPixel(im, p.world.x, p.world.y)
        const nc = cropRectFromDrag(cropDrag.startPix, endPix, im.natural)
        if (nc.w > 4 && nc.h > 4) {
          // 크롭 영역 중심의 현재 월드 위치 → 크롭 후 그 점이 새 중심이 되게(제자리 유지)
          const wc = pixelToWorld(im, nc.x + nc.w / 2, nc.y + nc.h / 2)
          commit()
          im.crop = nc
          im.transform.x = wc.x
          im.transform.y = wc.y
          scene.applyCrop(im.id, im)
          const s = scene.getSprite(im.id)
          if (s) scene.applyTransform(s, im)
          afterEdit()
        }
      }
    }
    exitCropMode()
    return
  }
  if (!drag) return
  if (drag.mode === 'rubber') {
    const r = rectOf(drag.start, p.world)
    const hits = scene.allIds().filter((id) => {
      const a = scene.getItemAABB(id)
      return a !== null && !(a.maxX < r.x || a.minX > r.x + r.w || a.maxY < r.y || a.minY > r.y + r.h)
    })
    // 러버밴드에 걸린 항목을 그룹 단위로 확장
    const expanded = expandByGroup(board.items, hits)
    if (drag.additive) for (const id of expanded) sel.add(id)
    else sel.set(expanded)
    scene.drawRubber(null)
  } else if (drag.mode === 'move') {
    host.style.cursor = ''
    scene.setCursor('grab')
    updateMinimap()
  } else if (drag.mode === 'gizmo') {
    host.style.cursor = ''
    updateMinimap()
  }
  drag = null
}

function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

// ---- 동작: 삭제 / 복제 / 패킹 / z순서 / 뒤집기 / 정렬 / 저장 / 열기 / Undo / Redo ----

function deleteSelected() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    scene.removeImage(id)
    const idx = board.items.findIndex((i) => i.id === id)
    if (idx >= 0) board.items.splice(idx, 1)
  }
  normalizeZ(board.items)
  syncZIndex()
  sel.clear()
  updateMinimap()
  if (board.items.length === 0) hint.style.display = ''
}

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
  fitAll()
}

// z순서 변경 공통: 히스토리 적재 → 모듈 호출 → zIndex 동기화
function applyZOrder(fn: (items: BoardImage[], ids: Set<string> | string[]) => void) {
  if (sel.size === 0) return
  commit()
  fn(board.items, sel.values())
  syncZIndex()
}
function syncZIndex() {
  for (const im of board.items) {
    const s = scene.getSprite(im.id)
    if (s) s.zIndex = im.z
  }
}

// 좌우/상하 뒤집기 (Alt+Shift+H / Alt+Shift+V) — 비파괴(transform.flipX/Y 토글)
function flipSelected(axis: 'x' | 'y') {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    const img = board.items.find((i) => i.id === id)
    if (!img) continue
    if (axis === 'x') img.transform.flipX = !img.transform.flipX
    else img.transform.flipY = !img.transform.flipY
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, img)
  }
}

// ---- 그룹 (Phase 2.6) ----
// 선택 2개 이상을 한 그룹으로 묶는다(같은 groupId 부여). 이후 멤버 클릭/러버밴드 시 그룹 통째 선택.
function groupSelected() {
  const plan = planGroup(board.items, sel.values())
  if (!plan) {
    showToast('그룹은 2개 이상 선택 시 가능합니다', true)
    return
  }
  commit()
  for (const id of plan.memberIds) {
    const im = board.items.find((i) => i.id === id)
    if (im) im.groupId = plan.groupId
  }
  showToast(`${plan.memberIds.length}개 그룹화`, true)
}
// 선택에 걸린 그룹(들)을 해제한다(groupId 제거).
function ungroupSelected() {
  const targets = planUngroup(board.items, sel.values())
  if (targets.length === 0) {
    showToast('해제할 그룹이 없습니다', true)
    return
  }
  commit()
  for (const id of targets) {
    const im = board.items.find((i) => i.id === id)
    if (im) delete im.groupId
  }
  showToast('그룹 해제', true)
}

// ---- 잠금 (Phase 2.7) ----
// 선택 항목의 잠금을 토글한다. 하나라도 안 잠겼으면 전체 잠금, 모두 잠겼으면 전체 해제.
// 잠긴 항목은 이동/기즈모 변형이 막히고(기존 로직), 외곽선이 주황으로 표시된다.
function toggleLock() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  const anyUnlocked = ids.some((id) => {
    const im = board.items.find((i) => i.id === id)
    return im ? !im.locked : false
  })
  for (const id of ids) {
    const im = board.items.find((i) => i.id === id)
    if (im) im.locked = anyUnlocked
  }
  afterEdit()
  showToast(anyUnlocked ? '잠금' : '잠금 해제', true)
}

// ---- 그리드 (Phase 2.8) ----
// 그리드가 켜져 있으면 현재 카메라/뷰포트 기준으로 다시 계산해 그린다. 꺼져 있으면 지운다.
function drawGridIfOn() {
  if (gridOn) scene.drawGrid(visibleGrid(cam, { w: host.clientWidth, h: host.clientHeight }))
  else scene.drawGrid(null)
}

// ---- 크롭 (Phase 2.2, 비파괴) ----
let cropMode = false
let cropTargetId: string | null = null
let cropDrag: { startPix: { x: number; y: number }; startWorld: { x: number; y: number } } | null = null

// 월드좌표 → 이미지 원본픽셀 (중심·scale·rotation·flip·기존 crop 역적용)
function worldToPixel(im: BoardImage, wx: number, wy: number): { x: number; y: number } {
  const dx = wx - im.transform.x
  const dy = wy - im.transform.y
  const cos = Math.cos(-im.transform.rotation)
  const sin = Math.sin(-im.transform.rotation)
  let lx = (dx * cos - dy * sin) / im.transform.scale
  let ly = (dx * sin + dy * cos) / im.transform.scale
  if (im.transform.flipX) lx = -lx
  if (im.transform.flipY) ly = -ly
  const dispW = im.crop ? im.crop.w : im.natural.w
  const dispH = im.crop ? im.crop.h : im.natural.h
  return { x: (im.crop ? im.crop.x : 0) + lx + dispW / 2, y: (im.crop ? im.crop.y : 0) + ly + dispH / 2 }
}
// 이미지 원본픽셀 → 월드좌표 (worldToPixel 역변환)
function pixelToWorld(im: BoardImage, px: number, py: number): { x: number; y: number } {
  const dispW = im.crop ? im.crop.w : im.natural.w
  const dispH = im.crop ? im.crop.h : im.natural.h
  let lx = px - (im.crop ? im.crop.x : 0) - dispW / 2
  let ly = py - (im.crop ? im.crop.y : 0) - dispH / 2
  if (im.transform.flipX) lx = -lx
  if (im.transform.flipY) ly = -ly
  lx *= im.transform.scale
  ly *= im.transform.scale
  const cos = Math.cos(im.transform.rotation)
  const sin = Math.sin(im.transform.rotation)
  return { x: im.transform.x + lx * cos - ly * sin, y: im.transform.y + lx * sin + ly * cos }
}
function enterCropMode() {
  if (sel.size !== 1) {
    showToast('크롭은 이미지 1개만 선택했을 때 가능합니다', true)
    return
  }
  cropMode = true
  cropTargetId = sel.values()[0]
  scene.drawGizmo([])
  showToast('크롭 모드: 이미지 위에서 드래그 · Esc 취소', true)
}
function exitCropMode() {
  cropMode = false
  cropTargetId = null
  cropDrag = null
  scene.drawRubber(null)
  refreshGizmo()
}
// 크롭 리셋 (Ctrl+Shift+C): 선택 항목의 crop 제거(원본 전체로)
function resetCrop() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    const im = board.items.find((i) => i.id === id)
    if (!im || !im.crop) continue
    delete im.crop
    scene.applyCrop(id, im)
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, im)
  }
  afterEdit()
}
// 변형 리셋 (Ctrl+Shift+T): scale=1·rotation=0·flip 해제 (crop·위치는 유지)
function resetTransform() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    const im = board.items.find((i) => i.id === id)
    if (!im) continue
    im.transform.scale = 1
    im.transform.rotation = 0
    im.transform.flipX = false
    im.transform.flipY = false
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, im)
  }
  afterEdit()
}

// ---- 정렬 / 분배 / 정규화 (Phase 2.4) ----
function alignItems(): AlignItem[] {
  const out: AlignItem[] = []
  for (const id of sel.values()) {
    const im = board.items.find((i) => i.id === id)
    const a = scene.getItemAABB(id)
    if (im && a) out.push({ id, aabb: a, cx: im.transform.x, cy: im.transform.y, natural: im.natural, scale: im.transform.scale })
  }
  return out
}
function applyDeltas(deltas: Map<string, { dx: number; dy: number }>) {
  for (const [id, d] of deltas) {
    const im = board.items.find((i) => i.id === id)
    if (!im) continue
    im.transform.x += d.dx
    im.transform.y += d.dy
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, im)
  }
}
function doAlign(edge: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter') {
  const items = alignItems()
  if (items.length < 2) return
  commit()
  applyDeltas(alignEdge(items, edge))
  afterEdit()
}
function doDistribute(axis: 'h' | 'v') {
  const items = alignItems()
  if (items.length < 3) return
  commit()
  applyDeltas(distribute(items, axis))
  afterEdit()
}
function doNormalize(mode: 'width' | 'height' | 'scale') {
  const items = alignItems()
  if (items.length < 2) return
  commit()
  for (const [id, sc] of normalizeSize(items, mode)) {
    const im = board.items.find((i) => i.id === id)
    if (!im) continue
    im.transform.scale = sc.scale
    const s = scene.getSprite(id)
    if (s) scene.applyTransform(s, im)
  }
  afterEdit()
}

// 파일 열기 다이얼로그 (Ctrl+I)
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

async function openBoard() {
  const file = await pickRefbFile()
  if (!file) return
  try {
    const state = await loadBoardFile(file)
    history.push(board)
    await restore(state)
    setDirty(false)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '파일 열기 실패')
  }
}

async function doUndo() {
  const prev = history.undo(board)
  if (prev) {
    await restore(prev)
    setDirty(true)
  }
}
async function doRedo() {
  const next = history.redo(board)
  if (next) {
    await restore(next)
    setDirty(true)
  }
}

function save() {
  saveBoard(board)
  setDirty(false)
}

// ---- 키보드 단축키 ----
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (e.key === ' ') {
    e.preventDefault()
    if (ctrl) fitAll()
    else focusSelected()
  } else if (ctrl && k === 'a') {
    e.preventDefault()
    sel.set(scene.allIds())
  } else if (e.key === 'Escape') {
    if (cropMode) {
      exitCropMode()
    } else {
      sel.clear()
      scene.drawRubber(null)
      drag = null
    }
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
  } else if (ctrl && e.shiftKey && k === 'g') {
    e.preventDefault()
    ungroupSelected()
  } else if (ctrl && k === 'g') {
    e.preventDefault()
    groupSelected()
  } else if (ctrl && !e.shiftKey && k === 'z') {
    e.preventDefault()
    void doUndo()
  } else if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) {
    e.preventDefault()
    void doRedo()
  } else if (ctrl && !e.shiftKey && e.key === 'ArrowLeft') {
    e.preventDefault()
    doAlign('left')
  } else if (ctrl && !e.shiftKey && e.key === 'ArrowRight') {
    e.preventDefault()
    doAlign('right')
  } else if (ctrl && !e.shiftKey && e.key === 'ArrowUp') {
    e.preventDefault()
    doAlign('top')
  } else if (ctrl && !e.shiftKey && e.key === 'ArrowDown') {
    e.preventDefault()
    doAlign('bottom')
  } else if (ctrl && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault()
    doDistribute('h')
  } else if (ctrl && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    doDistribute('v')
  } else if (e.code === 'BracketRight') {
    e.preventDefault()
    applyZOrder(e.shiftKey ? bringToFront : bringForward)
  } else if (e.code === 'BracketLeft') {
    e.preventDefault()
    applyZOrder(e.shiftKey ? sendToBack : sendBackward)
  } else if (!ctrl && k === 'm') {
    minimap.toggle()
    updateMinimap()
  } else if (!ctrl && k === 'n') {
    snapOn = !snapOn
    showToast(snapOn ? '스냅 켜짐 · 그리드/이웃' : '스냅 꺼짐', true)
  } else if (!ctrl && !e.altKey && k === 'g') {
    gridOn = !gridOn
    drawGridIfOn()
    showToast(gridOn ? '그리드 켜짐' : '그리드 꺼짐', true)
  } else if (e.altKey && e.code === 'KeyL') {
    e.preventDefault()
    toggleLock()
  } else if (e.altKey && e.shiftKey && e.code === 'KeyH') {
    e.preventDefault()
    flipSelected('x')
  } else if (e.altKey && e.shiftKey && e.code === 'KeyV') {
    e.preventDefault()
    flipSelected('y')
  } else if (ctrl && e.shiftKey && k === 'c') {
    e.preventDefault()
    resetCrop()
  } else if (ctrl && e.shiftKey && k === 't') {
    e.preventDefault()
    resetTransform()
  } else if (!ctrl && k === 'c') {
    enterCropMode()
  }
})

// ---- 가져오기 공통 ----
async function importFiles(files: File[], baseX: number, baseY: number) {
  if (files.length === 0) return
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

// 디버그용 전역 노출
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
  flip: flipSelected,
  group: groupSelected,
  ungroup: ungroupSelected,
  toggleLock,
  toggleGrid: () => ((gridOn = !gridOn), drawGridIfOn(), gridOn),
  crop: enterCropMode,
  resetCrop,
  resetTransform,
  align: doAlign,
  distribute: doDistribute,
  normalize: doNormalize,
  toggleSnap: () => ((snapOn = !snapOn), snapOn),
  toggleMinimap: () => (minimap.toggle(), updateMinimap()),
  undo: doUndo,
  redo: doRedo,
  save,
  getItem: (id: string) => board.items.find((i) => i.id === id),
}
