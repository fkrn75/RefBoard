import { Scene, type ScenePointer, type Rect } from './core/scene'
import { createEmptyBoard, genId, type BoardImage, type BoardState, type Transform } from './core/board'
import { Selection } from './core/selection'
import { packImages } from './core/pack'
import { loadBoardFile, loadBoardBlob, pickRefbFile } from './core/io'
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
import { packRefb } from './core/refb'
import { exportSceneAll, exportSelection, renderThumbnail, downloadBlob } from './core/export-image'
import { AutoSave } from './core/autosave'
import { addRecent, setLastSession, getLastSession } from './core/recent'
import { applyTheme, getTheme, onThemeChange } from './core/theme'
import { registerActions, matchKey, getActions, DEFAULT_ACTIONS, type Action } from './core/keymap'
import { openPalette, isPaletteOpen } from './core/command-palette'
import { downscaleIfLarge } from './core/downscale'
import {
  isDesktop,
  saveRefbNative,
  openRefbNative,
  setAlwaysOnTop,
  setAlwaysOnBottom,
  setDecorations,
  setClickThrough,
  setWindowOpacity,
  onOsFileDrop,
  readDroppedFile,
} from './core/tauri-bridge'
import { createToolbar } from './core/toolbar'
import { openSettings } from './core/settings-panel'
import { createVirtualizer } from './core/virtualize'
import { LocalShareAdapter } from './core/share-adapter'

// 앱 진입점: Scene을 만들고 입력(선택/이동/변형/줌/팬/가져오기/단축키)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement

// board는 undo/redo·열기로 통째 교체될 수 있어 let.
let board: BoardState = createEmptyBoard()
// 테마 부팅: 저장된 테마를 캔버스 생성 전에 적용해 배경/그리드 색이 처음부터 일치하게 한다.
applyTheme(getTheme())
const scene = await Scene.create(host)
const sel = new Selection()
const history = new History()
let cam = { ...board.camera }

// ---- 데스크탑 UI 셸: 툴바 + 상태바(4.4) ----
// 버튼 클릭은 모두 runAction(키맵과 동일 actionId)으로 흘려보내 단축키와 동작을 일원화한다.
const toolbar = createToolbar({ onAction: (id) => runAction(id), isDesktop: isDesktop() })

// ---- 대량 이미지 가상화(4.6): 가시영역 밖 GPU 텍스처 언로드 ----
const virt = createVirtualizer({
  getItems: () =>
    board.items.map((im) => ({
      id: im.id,
      cx: im.transform.x,
      cy: im.transform.y,
      w: im.natural.w * im.transform.scale,
      h: im.natural.h * im.transform.scale,
    })),
  getViewBounds: () => {
    const tl = scene.screenToWorld(0, 0)
    const br = scene.screenToWorld(host.clientWidth, host.clientHeight)
    return { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
  },
  onLoad: (id) => {
    const s = scene.getSprite(id)
    if (s) s.visible = true
  },
  onUnload: (id) => {
    const s = scene.getSprite(id)
    if (s) {
      s.visible = false
      s.texture.source.unload() // GPU 텍스처만 해제(board.src 보존 → 다시 보이면 자동 재업로드)
    }
  },
})

// 선택이 바뀌면 선택 외곽선 + 기즈모 + 투명도 패널 다시 그림 + 상태바 갱신
sel.onChange(() => {
  scene.drawSelection(sel.values(), lockedIdSet())
  refreshGizmo()
  syncOpacityControl()
  toolbar.updateStatus({ selCount: sel.values().length, total: board.items.length })
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
  // 종료 직전 현재 보드를 "마지막 세션"으로 저장(다음 실행에서 이어 열기). 동기 localStorage라 안전.
  try {
    setLastSession(board)
  } catch {
    // 용량 초과 등은 무시(마지막 세션은 "있으면 좋은" 편의 기능)
  }
  if (!dirty) return
  e.preventDefault()
  e.returnValue = ''
})

// ---- 자동저장 / 크래시 복구 ----
// 5분 주기로 현재 보드를 IndexedDB 스냅샷에 저장. getState는 항상 최신 board(let)를 클로저로 참조.
// start()/복구 프롬프트 배선은 파일 하단의 부팅 초기화에서 처리(복구본 보존 순서 때문).
const autosave = new AutoSave({
  getState: () => board,
  onError: (err) => console.warn('[autosave] 저장 실패', err),
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
  toolbar.updateStatus({ zoom: cam.zoom, selCount: sel.values().length, total: board.items.length })
  virt.update() // 카메라 이동/줌마다 가시영역 재평가 → 텍스처 로드/언로드
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
  if (canvasLocked) return // 캔버스 잠금 중에는 편집(선택/이동/변형) 차단 — 팬·줌·단축키는 유지
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
  try {
    let state: BoardState
    let fileName: string
    let fileSize: number | undefined
    if (isDesktop()) {
      // 데스크탑: 네이티브 열기 다이얼로그 → 바이트 읽기.
      const opened = await openRefbNative()
      if (!opened) return // 취소
      state = await loadBoardBlob(new Blob([opened.bytes as BlobPart]))
      fileName = opened.name
      fileSize = opened.bytes.byteLength
    } else {
      // 웹: <input type=file>로 선택.
      const file = await pickRefbFile()
      if (!file) return
      state = await loadBoardFile(file)
      fileName = file.name
      fileSize = file.size
    }
    history.push(board)
    await restore(state)
    // 최근 파일 등록 + 새 보드를 열었으니 이전 크래시 복구본 해제.
    addRecent({ name: fileName, ts: Date.now(), size: fileSize })
    await autosave.clearRecovery()
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

async function save() {
  // 썸네일(보드 미리보기)을 먼저 렌더 — 오버레이를 숨겨 UI가 섞이지 않게 한 뒤 추출.
  let thumb: Uint8Array | undefined
  try {
    const restoreOverlays = scene.hideOverlays()
    thumb = await renderThumbnail(scene.app.renderer, scene.world)
    restoreOverlays()
  } catch {
    thumb = undefined // 썸네일 실패는 저장을 막지 않음
  }
  // 보드를 .refb(ZIP 컨테이너)로 패킹.
  const blob = await packRefb(board, { thumbnail: thumb })
  const base = (board.board.title || '').trim().replace(/\s+/g, '_') || 'board'
  const name = base + '.refb'
  // 데스크탑(Tauri)이면 네이티브 저장 다이얼로그로 실제 경로에 기록, 웹이면 브라우저 다운로드.
  let savedName = name
  if (isDesktop()) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const savedPath = await saveRefbNative(bytes, name)
    if (!savedPath) return // 사용자가 저장 취소
    savedName = savedPath.replace(/^.*[\\/]/, '')
  } else {
    downloadBlob(blob, name)
  }
  // 최근 파일 등록 + 크래시 복구 스냅샷 해제(정상 저장 완료) + dirty 해제.
  addRecent({ name: savedName, ts: Date.now(), size: blob.size })
  await autosave.clearRecovery()
  setDirty(false)
  showToast('저장됨 · ' + savedName, true)
}

// ---- 내보내기(Export): 씬/선택 → PNG ----
// 오버레이(선택/기즈모/그리드)를 숨긴 world를 추출해 UI가 결과 이미지에 섞이지 않게 한다.
async function exportScene() {
  const restoreOverlays = scene.hideOverlays()
  try {
    const blob = await exportSceneAll(scene.app.renderer, scene.world, { format: 'png', padding: 16 })
    downloadBlob(blob, 'refboard-scene.png')
    showToast('씬 전체를 PNG로 내보냈습니다', true)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '내보내기 실패')
  } finally {
    restoreOverlays()
  }
}
async function exportSel() {
  const ids = sel.values()
  if (ids.length === 0) {
    showToast('내보낼 항목을 선택하세요', true)
    return
  }
  const restoreOverlays = scene.hideOverlays()
  try {
    const blob = await exportSelection(
      scene.app.renderer,
      scene.world,
      ids,
      (id) => scene.getSprite(id),
      { format: 'png', padding: 8 },
    )
    downloadBlob(blob, 'refboard-selection.png')
    showToast(`선택 ${ids.length}개를 PNG로 내보냈습니다`, true)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '내보내기 실패')
  } finally {
    restoreOverlays()
  }
}

// ---- 키맵 + 테마 배선 ----
// 데스크탑 전용 윈도우 모드 액션(웹에선 no-op + 안내 토스트). 기본 액션 뒤에 합쳐 등록.
const WINDOW_ACTIONS: Action[] = [
  { id: 'window.toggleAlwaysOnTop', label: '항상 위', group: '창', defaultCombo: 'Ctrl+Shift+A' },
  { id: 'window.toggleAlwaysOnBottom', label: '항상 아래', group: '창', defaultCombo: 'Ctrl+Shift+B' },
  { id: 'window.toggleDecorations', label: '타이틀바 숨김/표시', group: '창', defaultCombo: 'Ctrl+Shift+D' },
  { id: 'window.toggleClickThrough', label: '마우스 통과(클릭스루)', group: '창', defaultCombo: 'Ctrl+Alt+T' },
  { id: 'window.cycleOpacity', label: '창 불투명도 순환', group: '창', defaultCombo: 'Ctrl+Shift+O' },
  { id: 'window.toggleLock', label: '캔버스 잠금', group: '창', defaultCombo: 'Ctrl+Shift+L' },
]
// 설정 패널(테마·단축키) 열기 — '앱' 그룹.
const APP_EXTRA_ACTIONS: Action[] = [
  { id: 'app.settings', label: '설정', group: '앱', defaultCombo: 'Ctrl+,' },
  { id: 'share.webLink', label: '웹 뷰어 링크 공유', group: '앱', defaultCombo: 'Ctrl+Shift+S' },
]
// 단축키 액션 카탈로그 등록(저장된 사용자 재바인딩도 이때 함께 로드된다).
registerActions([...DEFAULT_ACTIONS, ...WINDOW_ACTIONS, ...APP_EXTRA_ACTIONS])

// ---- 윈도우 모드 토글(데스크탑 전용 · PureRef 정체성) ----
let winAlwaysOnTop = false
let winDecorations = true
let winClickThrough = false
async function toggleAlwaysOnTop() {
  if (!isDesktop()) return showToast('데스크탑 앱에서만 사용할 수 있습니다', true)
  winAlwaysOnTop = !winAlwaysOnTop
  await setAlwaysOnTop(winAlwaysOnTop)
  showToast(winAlwaysOnTop ? '항상 위 켜짐' : '항상 위 꺼짐', true)
}
async function toggleDecorations() {
  if (!isDesktop()) return showToast('데스크탑 앱에서만 사용할 수 있습니다', true)
  winDecorations = !winDecorations
  await setDecorations(winDecorations)
  showToast(winDecorations ? '타이틀바 표시' : '타이틀바 숨김 · 미니멀', true)
}
async function toggleClickThrough() {
  if (!isDesktop()) return showToast('데스크탑 앱에서만 사용할 수 있습니다', true)
  winClickThrough = !winClickThrough
  await setClickThrough(winClickThrough)
  showToast(winClickThrough ? '마우스 통과 켜짐 · 단축키로 해제' : '마우스 통과 꺼짐', true)
}
// 항상 아래(바탕화면 위 레퍼런스). 항상 위와 배타적으로 토글.
let winAlwaysOnBottom = false
async function toggleAlwaysOnBottom() {
  if (!isDesktop()) return showToast('데스크탑 앱에서만 사용할 수 있습니다', true)
  winAlwaysOnBottom = !winAlwaysOnBottom
  await setAlwaysOnBottom(winAlwaysOnBottom)
  if (winAlwaysOnBottom && winAlwaysOnTop) {
    // 위·아래 동시 불가 → 위를 끈다.
    winAlwaysOnTop = false
    await setAlwaysOnTop(false)
    toolbar.setActive('window.toggleAlwaysOnTop', false)
  }
  toolbar.setActive('window.toggleAlwaysOnBottom', winAlwaysOnBottom)
  showToast(winAlwaysOnBottom ? '항상 아래 켜짐' : '항상 아래 꺼짐', true)
}
// 창 불투명도 순환(100→85→65→40). Rust 커스텀 커맨드 set_window_opacity로 적용.
const OPACITY_STEPS = [1, 0.85, 0.65, 0.4]
let opacityIdx = 0
async function cycleOpacity() {
  if (!isDesktop()) return showToast('데스크탑 앱에서만 사용할 수 있습니다', true)
  opacityIdx = (opacityIdx + 1) % OPACITY_STEPS.length
  const o = OPACITY_STEPS[opacityIdx]
  await setWindowOpacity(o)
  showToast(`창 불투명도 ${Math.round(o * 100)}%`, true)
}
// 캔버스 잠금: 편집/이동 입력을 막아 레이아웃 고정(보기·단축키는 유지).
let canvasLocked = false
function toggleCanvasLock() {
  canvasLocked = !canvasLocked
  toolbar.setActive('window.toggleLock', canvasLocked)
  showToast(canvasLocked ? '캔버스 잠금 · 편집/이동 차단' : '캔버스 잠금 해제', true)
}
// 웹 뷰어 링크 공유(서버리스 1차): LocalShareAdapter로 보드를 같은-출처 localStorage에 저장하고
// viewer.html#/b/<id> 링크를 클립보드에 복사한다. 같은 브라우저 왕복용 — 기기간은 Supabase 어댑터(후속).
async function shareWebLink() {
  try {
    const adapter = new LocalShareAdapter(location.origin + '/viewer.html')
    const { url } = await adapter.upload(board)
    try {
      await navigator.clipboard.writeText(url)
      showToast('웹 뷰어 링크 복사됨(같은 브라우저): ' + url, true)
    } catch {
      showToast('웹 뷰어 링크: ' + url, true)
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : '웹 공유 실패', true)
  }
}

// 테마 변경 시 캔버스 배경 + 그리드 + 선택 외곽선을 새 색으로 다시 그린다.
onThemeChange(() => {
  scene.refreshBackground()
  drawGridIfOn()
  scene.drawSelection(sel.values(), lockedIdSet())
  refreshGizmo()
})

// 키맵 액션 id를 실제 동작으로 잇는 디스패처(단축키·커맨드 팔레트 공용 진입점).
function runAction(id: string) {
  switch (id) {
    // 보기
    case 'view.fitAll': fitAll(); break
    case 'view.focusSelected': focusSelected(); break
    case 'view.zoomReset': zoomReset(); break
    case 'view.toggleMinimap': minimap.toggle(); updateMinimap(); break
    case 'view.toggleSnap':
      snapOn = !snapOn
      showToast(snapOn ? '스냅 켜짐 · 그리드/이웃' : '스냅 꺼짐', true)
      break
    case 'view.toggleGrid':
      gridOn = !gridOn
      drawGridIfOn()
      showToast(gridOn ? '그리드 켜짐' : '그리드 꺼짐', true)
      break
    // 편집
    case 'edit.selectAll': sel.set(scene.allIds()); break
    case 'edit.escape':
      if (cropMode) exitCropMode()
      else {
        sel.clear()
        scene.drawRubber(null)
        drag = null
      }
      break
    case 'edit.delete': deleteSelected(); break
    case 'edit.duplicate': void duplicateSelected(); break
    case 'edit.undo': void doUndo(); break
    case 'edit.redo': void doRedo(); break
    case 'edit.toggleLock': toggleLock(); break
    // 정렬·배치
    case 'arrange.pack': packAll(); break
    case 'arrange.group': groupSelected(); break
    case 'arrange.ungroup': ungroupSelected(); break
    case 'arrange.alignLeft': doAlign('left'); break
    case 'arrange.alignRight': doAlign('right'); break
    case 'arrange.alignTop': doAlign('top'); break
    case 'arrange.alignBottom': doAlign('bottom'); break
    case 'arrange.distributeH': doDistribute('h'); break
    case 'arrange.distributeV': doDistribute('v'); break
    case 'arrange.bringForward': applyZOrder(bringForward); break
    case 'arrange.bringToFront': applyZOrder(bringToFront); break
    case 'arrange.sendBackward': applyZOrder(sendBackward); break
    case 'arrange.sendToBack': applyZOrder(sendToBack); break
    // 변형
    case 'transform.crop': enterCropMode(); break
    case 'transform.resetCrop': resetCrop(); break
    case 'transform.resetTransform': resetTransform(); break
    case 'transform.flipH': flipSelected('x'); break
    case 'transform.flipV': flipSelected('y'); break
    // 파일
    case 'file.import': openImageFiles(); break
    case 'file.save': void save(); break
    case 'file.open': void openBoard(); break
    case 'file.exportScene': void exportScene(); break
    case 'file.exportSelection': void exportSel(); break
    // 앱
    case 'app.commandPalette': openCommandPalette(); break
    // 창(데스크탑 전용)
    case 'window.toggleAlwaysOnTop': void toggleAlwaysOnTop(); break
    case 'window.toggleAlwaysOnBottom': void toggleAlwaysOnBottom(); break
    case 'window.toggleDecorations': void toggleDecorations(); break
    case 'window.toggleClickThrough': void toggleClickThrough(); break
    case 'window.cycleOpacity': void cycleOpacity(); break
    case 'window.toggleLock': toggleCanvasLock(); break
    // 앱(설정 패널)
    case 'app.settings': openSettings(); break
    case 'share.webLink': void shareWebLink(); break
  }
}

// 커맨드 팔레트 열기(현재 액션 목록 전달, 항목 선택 시 runAction 실행).
function openCommandPalette() {
  openPalette(getActions(), (id) => runAction(id))
}

// ---- 키보드 단축키 ----
// 키맵 테이블(matchKey)로 액션을 찾아 runAction에 위임한다. 재바인딩이 그대로 반영된다.
window.addEventListener('keydown', (e) => {
  // 입력 필드(팔레트 검색창 등) 포커스 중에는 단축키를 가로채지 않는다.
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
  // 팔레트가 열려 있으면 팔레트가 캡처 단계에서 키를 처리하므로 여기선 무시.
  if (isPaletteOpen()) return

  const actionId = matchKey(e)
  if (actionId) {
    e.preventDefault()
    runAction(actionId)
    return
  }
  // 보조 바인딩(키맵 테이블엔 Delete/Ctrl+Shift+Z만 등록): Backspace=삭제, Ctrl+Y=다시실행.
  const ctrl = e.ctrlKey || e.metaKey
  if (e.key === 'Backspace') {
    deleteSelected()
  } else if (ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    void doRedo()
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
      // 대형 이미지는 자동 다운스케일(메모리·.refb 크기·렌더 성능 절감). 긴 변 4096px 초과분만 줄인다.
      // downscaleIfLarge가 결과 픽셀 크기를 함께 반환하므로 별도 imageSize 호출은 불필요.
      const ds = await downscaleIfLarge(url, { maxEdge: 4096 })
      valid.push({ url: ds.dataUrl, size: { w: ds.width, h: ds.height } })
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
  exportScene,
  exportSel,
  open: openBoard,
  getItem: (id: string) => board.items.find((i) => i.id === id),
}

// ---- 부팅 초기화: 크래시 복구 → 마지막 세션 이어 열기 → 자동저장 시작 ----
// 순서가 중요하다: 자동저장 start()는 복구 처리가 끝난 뒤에 호출해야 복구본을 빈 스냅샷이 덮지 않는다.
function loadLastSessionIfAny() {
  if (board.items.length > 0) return // 이미 내용이 있으면 건드리지 않음
  const last = getLastSession()
  if (last && last.items.length > 0) {
    void restore(last)
    showToast('마지막 세션을 불러왔습니다', true)
  }
}
void (async () => {
  try {
    if (await autosave.hasRecovery()) {
      const ts = await autosave.getRecoveryTimestamp()
      const when = ts ? new Date(ts).toLocaleString() : '이전'
      if (window.confirm(`비정상 종료로 저장되지 않은 작업이 있습니다(${when}).\n복구하시겠습니까?`)) {
        const recovered = await autosave.loadRecovery()
        if (recovered) {
          await restore(recovered)
          setDirty(true) // 복구본은 아직 .refb로 저장되지 않은 상태
          showToast('자동저장본을 복구했습니다', true)
        }
      } else {
        await autosave.clearRecovery() // 복구 거부 → 스냅샷 비우고 마지막 세션으로 폴백
        loadLastSessionIfAny()
      }
    } else {
      loadLastSessionIfAny()
    }
  } catch (err) {
    console.warn('[부팅 복구] 실패', err)
  } finally {
    autosave.start() // 복구 처리 후 주기 저장 시작
  }
})()

// ---- OS 네이티브 파일 드롭(데스크탑 전용 · 4.2) ----
// 웹 드롭(host 'drop')과 달리 Tauri는 실제 파일 절대경로를 준다. 경로로 읽어 이미지로 임포트.
if (isDesktop()) {
  const DROP_MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  }
  void onOsFileDrop(async (paths) => {
    const imgs = paths.filter((p) => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(p))
    if (imgs.length === 0) return
    const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
    const files: File[] = []
    for (const p of imgs) {
      try {
        const { bytes, name } = await readDroppedFile(p)
        const ext = (name.split('.').pop() || '').toLowerCase()
        // Uint8Array → ArrayBuffer(정확한 구간 복사). TS5.7 BlobPart 타입 엄격성(SharedArrayBuffer 배제) 회피.
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        files.push(new File([ab], name, { type: DROP_MIME[ext] || 'application/octet-stream' }))
      } catch (err) {
        console.warn('[OS drop]', p, err)
      }
    }
    if (files.length) await importFiles(files, center.x, center.y)
  })
}
