import { Scene, type ScenePointer, type Rect } from './core/scene'
import {
  createEmptyBoard,
  genId,
  isImageItem,
  isNoteItem,
  isDrawingItem,
  type BoardImage,
  type BoardItem,
  type BoardNote,
  type BoardDrawing,
  type DrawingTool,
  type BoardState,
  type Transform,
} from './core/board'
import { Selection } from './core/selection'
import { packImagesOffThread } from './core/pack-worker-client'
import { loadBoardFile, loadBoardBlob, pickRefbFile } from './core/io'
import { History } from './core/history'
import { Minimap } from './core/minimap'
import { snapToNeighbors, snapDeltaToGrid, type AABB } from './core/snap'
import { bringToFront, sendToBack, bringForward, sendBackward, normalizeZ } from './core/zorder'
import { alignEdge, distribute, normalizeSize, type AlignItem } from './core/align'
import { handlePositions, hitTest, scaleFromHandle, rotateFromPointer, type HandleId } from './core/gizmo'
import { cropRectFromDrag, croppedSize } from './core/crop'
import { expandByGroup, planGroup, planUngroup } from './core/group'
import { visibleGrid } from './core/grid'
import { OpacityControl } from './core/opacity-control'
import { StyleControl, type StyleValues, FONT_OPTIONS } from './core/style-control'
import { packRefb } from './core/refb'
import { exportSceneAll, exportSelection, exportEach, renderThumbnail, downloadBlob, withImageExt, type ExportFormat } from './core/export-image'
import { AutoSave } from './core/autosave'
import { addRecent, setLastSession, getLastSession, getRecent, clearRecent } from './core/recent'
import { arrangeGrid, type SortItem, type SortKey } from './core/arrange-sort'
import { pickColor, showColorSwatch, copyColor } from './core/eyedropper'
import { openRecentPicker } from './core/recent-picker'
import { applyTheme, getTheme, onThemeChange } from './core/theme'
import { registerActions, matchKey, getActions, DEFAULT_ACTIONS, type Action } from './core/keymap'
import { openPalette, isPaletteOpen } from './core/command-palette'
import { downscaleIfLarge, blobToDataURL } from './core/downscale'
import { IMAGE_MAX_EDGE, OVERLAY_Z_INDEX, ZOOM_MAX, ZOOM_MIN } from './core/constants'
import { mapWithConcurrency } from './core/concurrency'
import { maybeStartRubberDrag } from './core/selection-drag'
import { attachEditorTwoFingerGestures } from './core/editor-touch'
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
import { openConfirmDialog, openPromptDialog } from './core/dialog'
import { createNoteEditor } from './core/note-editor'
import { createCursorReporter } from './core/cursor-reporter'
import { createDrawingTool } from './core/drawing-tool'
import { createShareIo } from './core/share-io'

// 앱 진입점: Scene을 만들고 입력(선택/이동/변형/줌/팬/가져오기/단축키)을 배선한다.
const host = document.getElementById('app') as HTMLElement
const hint = document.getElementById('hint') as HTMLElement
const hintImportButton = document.getElementById('hint-import') as HTMLButtonElement | null
const hintOpenButton = document.getElementById('hint-open') as HTMLButtonElement | null

// board는 undo/redo·열기로 통째 교체될 수 있어 let.
let board: BoardState = createEmptyBoard()
let itemIndexSource: BoardItem[] | null = null
let itemIndexLength = -1
let itemIndex = new Map<string, BoardItem>()
let lockedCacheSource: BoardItem[] | null = null
let lockedCacheLength = -1
let lockedCacheRevision = 0
let lockedCacheSeenRevision = -1
let lockedCache = new Set<string>()
// 테마 부팅: 저장된 테마를 캔버스 생성 전에 적용해 배경/그리드 색이 처음부터 일치하게 한다.
applyTheme(getTheme())
const scene = await Scene.create(host)
const sel = new Selection()
const history = new History()
let cam = { ...board.camera }

function getItem(id: string): BoardItem | undefined {
  if (itemIndexSource !== board.items || itemIndexLength !== board.items.length) {
    itemIndex = new Map(board.items.map((item) => [item.id, item]))
    itemIndexSource = board.items
    itemIndexLength = board.items.length
  }
  return itemIndex.get(id)
}

function markLockedCacheDirty(): void {
  lockedCacheRevision += 1
}

// ---- 데스크탑 UI 셸: 툴바 + 상태바(4.4) ----
// 버튼 클릭은 모두 runAction(키맵과 동일 actionId)으로 흘려보내 단축키와 동작을 일원화한다.
const toolbar = createToolbar({
  onAction: (id) => runAction(id),
  isDesktop: isDesktop(),
  onRenameBoard: () => {
    void renameBoard()
  },
})
const cursorReporter = createCursorReporter((cursor) => toolbar.updateStatus({ cursor }))

hintImportButton?.addEventListener('click', () => {
  void openImageFiles()
})
hintOpenButton?.addEventListener('click', () => {
  void openBoard()
})

async function renameBoard(): Promise<void> {
  const name = await openPromptDialog({
    title: '보드 이름 변경',
    label: '보드 이름',
    initialValue: board.board.title || '',
    confirmLabel: '저장',
  })
  if (name === null) return
  board.board.title = name.trim() || '제목 없음'
  void autosave.saveNow()
  refreshBoardStatus()
}

// 상태바의 보드 이름·공유 배지를 현재 board 상태로 갱신한다(restore·이름변경·공유 후 호출).
function refreshBoardStatus(): void {
  const sid = board.board.shareId
  const share: 'local' | 'public' | 'private' = !sid ? 'local' : board.board.sharePublic ? 'public' : 'private'
  toolbar.updateStatus({ boardName: board.board.title || '제목 없음', share })
}

// ---- 활성 도구(텍스트·드로잉) 상태 ----
// 'select'(기본)에서만 기존 선택/이동/러버밴드/기즈모가 동작한다. 나머지 도구는 캔버스 입력을
// 자기 동작(텍스트 배치 · 드로잉 드래그 · 지우개)으로 가로챈다(scene.onPointer* 진입부에서 분기).
type ActiveTool = 'select' | 'text' | 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'eraser' | 'eyedropper'
let activeTool: ActiveTool = 'select'
// 드로잉/텍스트 "현재 그리기" 기본 스타일(scale=1 기준). StyleControl로 실시간 변경한다.
// 선택 아이템이 없을 때(도구 모드)의 변경은 "다음 생성" 기본값을 바꾸고, 선택이 있으면 그 아이템을 바꾼다.
let DRAW_COLOR = '#ff5a5a'
let DRAW_WIDTH = 4
let TEXT_COLOR = '#ffffff'
let TEXT_FONT_SIZE = 28
let TEXT_FONT_FAMILY = FONT_OPTIONS[0].value // 기본 글꼴(Pretendard/맑은 고딕)

// 도구 버튼 활성 표시를 현재 activeTool에 맞춰 토글한다(선택 도구 포함, 한 번에 하나만 강조).
const TOOL_ACTION_IDS: Record<ActiveTool, string> = {
  select: 'tool.select',
  text: 'tool.text',
  pen: 'tool.pen',
  line: 'tool.line',
  rect: 'tool.rect',
  ellipse: 'tool.ellipse',
  arrow: 'tool.arrow',
  eraser: 'tool.eraser',
  eyedropper: 'tool.eyedropper',
}
function setActiveTool(tool: ActiveTool) {
  if (activeTool === tool) return
  // 진행 중이던 드로잉/텍스트 편집은 도구 전환 시 정리(취소).
  drawingTool.cancel()
  noteEditor.commit() // 편집 중 텍스트가 있으면 확정 후 전환
  activeTool = tool
  for (const t of Object.keys(TOOL_ACTION_IDS) as ActiveTool[]) {
    toolbar.setActive(TOOL_ACTION_IDS[t], t === tool)
  }
  // 커서 힌트: 드로잉/텍스트는 십자, 지우개는 not-allowed 느낌, 선택은 기본.
  host.style.cursor = tool === 'select' ? '' : tool === 'eraser' ? 'cell' : 'crosshair'
  scene.setCursor(tool === 'select' ? 'grab' : 'crosshair')
  showToast(TOOL_HINT[tool], true)
  refreshStyleControl() // 도구 전환 시 스타일 패널 갱신(드로잉=색+굵기 / 텍스트=색+크기)
}
const TOOL_HINT: Record<ActiveTool, string> = {
  select: '선택 도구',
  text: '텍스트: 캔버스를 클릭해 입력 · 노트 더블클릭으로 재편집',
  pen: '펜: 드래그해 자유선 그리기',
  line: '직선: 드래그',
  rect: '사각형: 드래그',
  ellipse: '타원: 드래그',
  arrow: '화살표: 드래그',
  eraser: '지우개: 드로잉을 클릭/드래그해 삭제',
  eyedropper: '스포이드: 캔버스를 클릭해 색을 추출(클립보드 복사)',
}

// 월드 좌표 → 화면 좌표(미리보기·노트 입력기·스포이드 등에서 공용). 드로잉 미리보기 캔버스는
// drawing-tool 모듈이 자체 소유한다(7.3 God-file 분리).
function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y }
}

// 기즈모/선택 외곽선 산출용 "표시 박스 크기"(scale=1 기준 natural).
// 이미지는 크롭 반영(croppedSize), 노트/드로잉은 측정/바운딩 박스(natural) 그대로.
function itemDisplaySize(item: BoardItem): { w: number; h: number } {
  return isImageItem(item) ? croppedSize(item.crop, item.natural) : item.natural
}

// 아이템의 transform/opacity/z 변경을 scene 노드에 반영(타입 무관).
// 이미지=applyTransform(Sprite), 노트=updateNote, 드로잉=updateDrawing. getSprite는 이미지에만
// 노드를 돌려주므로, 노트/드로잉 이동·변형도 화면에 반영되도록 타입별 경로로 분기한다.
function syncNode(item: BoardItem) {
  if (item.type === 'note') {
    scene.updateNote(item)
  } else if (item.type === 'drawing') {
    scene.updateDrawing(item)
  } else {
    const s = scene.getSprite(item.id)
    if (s) scene.applyTransform(s, item)
  }
}

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
  refreshStyleControl()
  toolbar.updateStatus({ selCount: sel.values().length, total: board.items.filter(isImageItem).length })
})

// ---- UI: 로딩 인디케이터 / 토스트 / 저장상태(dirty) ----
const loadingEl = document.createElement('div')
loadingEl.style.cssText =
  'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:14px 22px;' +
  'background:rgba(20,20,20,.85);color:#eee;border-radius:10px;font:14px system-ui,sans-serif;' +
  `pointer-events:none;z-index:${OVERLAY_Z_INDEX};display:none;box-shadow:0 6px 20px rgba(0,0,0,.5)`
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
  `z-index:${OVERLAY_Z_INDEX};opacity:0;transition:opacity .25s;max-width:80vw;text-align:center`
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
  } catch (err) {
    // 용량 초과 등은 무시(마지막 세션은 "있으면 좋은" 편의 기능)
    console.warn('[recent] 마지막 세션 저장 실패', err)
  }
  if (!dirty) return
  e.preventDefault()
  e.returnValue = ''
})

// ---- 자동저장 / 크래시 복구 ----
// 5분 주기로 현재 보드를 IndexedDB 스냅샷에 저장. getState는 항상 최신 board(let)를 클로저로 참조.
// start()/복구 프롬프트 배선은 파일 하단의 부팅 초기화에서 처리(복구본 보존 순서 때문).
let autosaveFailureNotified = false
const autosave = new AutoSave({
  getState: () => board,
  onError: (err) => {
    console.warn('[autosave] 저장 실패', err)
    if (autosaveFailureNotified) return
    autosaveFailureNotified = true
    showToast('자동저장에 실패했습니다. 수동 저장을 권장합니다.')
  },
})

// ---- 미니맵 / 스냅 / 그리드 / 투명도 ----
const minimap = new Minimap(host)
minimap.setVisible(false)
let snapOn = false
let gridOn = false

// 잠긴 아이템 id 집합(선택 외곽선 색 구분용)
function lockedIdSet(): Set<string> {
  if (
    lockedCacheSource !== board.items ||
    lockedCacheLength !== board.items.length ||
    lockedCacheSeenRevision !== lockedCacheRevision
  ) {
    lockedCache = new Set<string>()
    for (const im of board.items) if (im.locked) lockedCache.add(im.id)
    lockedCacheSource = board.items
    lockedCacheLength = board.items.length
    lockedCacheSeenRevision = lockedCacheRevision
  }
  return lockedCache
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
    const im = getItem(id)
    if (!im) continue
    im.opacity = v
    syncNode(im) // 이미지=alpha 직접, 노트/드로잉=update*로 반영(타입 무관)
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
  const im = getItem(ids[0])
  opacityCtl.show(im ? im.opacity : 1)
}

// ---- 스타일 컨트롤(색·굵기·글자크기) ----
const styleCtl = new StyleControl(host)
let styleCommitted = false // 색/슬라이더 조작 중 1회만 commit(undo 1스텝)

// 스타일 변경 대상: 선택된 노트/드로잉(잠금 제외). 이미지는 색/굵기 개념이 없어 제외한다.
function styleTargets(): (BoardNote | BoardDrawing)[] {
  const out: (BoardNote | BoardDrawing)[] = []
  for (const id of sel.values()) {
    const it = getItem(id)
    if (it && !it.locked && (isNoteItem(it) || isDrawingItem(it))) out.push(it)
  }
  return out
}

// 선택/도구 상태에 맞춰 스타일 패널 표시를 갱신한다.
//  - 노트/드로잉 선택 → 그 값(색 + 굵기/크기) 표시(대표=첫 항목)
//  - 선택 없음 + 드로잉/텍스트 도구 → "다음 생성" 기본값 표시
//  - 그 외(이미지 선택·select 도구·빈 선택) → 숨김
function refreshStyleControl() {
  const ts = styleTargets()
  if (ts.length > 0) {
    const v: StyleValues = { color: ts[0].color }
    const draw = ts.find(isDrawingItem)
    const note = ts.find(isNoteItem)
    if (draw) v.width = draw.width
    if (note) {
      v.fontSize = note.fontSize
      v.fontFamily = note.fontFamily ?? TEXT_FONT_FAMILY
    }
    styleCtl.show(v)
    return
  }
  if (activeTool === 'pen' || activeTool === 'line' || activeTool === 'rect' || activeTool === 'ellipse' || activeTool === 'arrow') {
    styleCtl.show({ color: DRAW_COLOR, width: DRAW_WIDTH })
  } else if (activeTool === 'text') {
    styleCtl.show({ color: TEXT_COLOR, fontSize: TEXT_FONT_SIZE, fontFamily: TEXT_FONT_FAMILY })
  } else {
    styleCtl.hide()
  }
}

// 색: 선택 아이템이 있으면 그 아이템 색을, 없으면 "다음 생성" 기본값을 바꾼다.
styleCtl.onColorInput = (hex) => {
  const ts = styleTargets()
  if (ts.length > 0) {
    if (!styleCommitted) {
      commit()
      styleCommitted = true
    }
    for (const it of ts) {
      it.color = hex
      syncNode(it) // 노트=updateNote / 드로잉=updateDrawing로 재렌더(색 반영)
    }
    // 마지막 사용 색을 다음 생성 기본값에도 반영해 편집 중 값이 유지되게 한다.
    if (ts.some(isDrawingItem)) DRAW_COLOR = hex
    if (ts.some(isNoteItem)) TEXT_COLOR = hex
  } else if (activeTool === 'text') {
    TEXT_COLOR = hex
  } else {
    DRAW_COLOR = hex
  }
}
styleCtl.onColorChange = (hex) => {
  styleCtl.onColorInput?.(hex) // 값 반영(선택 아이템 또는 기본값) — input이 안 온 브라우저 대비
  styleCommitted = false // 다음 조작을 위해 리셋
  afterEdit()
}

// 굵기: 드로잉만 대상(텍스트엔 굵기 없음). 선택 없으면 기본값.
styleCtl.onWidthInput = (w) => {
  const ds = styleTargets().filter(isDrawingItem)
  if (ds.length > 0) {
    if (!styleCommitted) {
      commit()
      styleCommitted = true
    }
    for (const d of ds) {
      d.width = w
      scene.updateDrawing(d)
    }
    DRAW_WIDTH = w // 마지막 굵기를 다음 생성 기본값에도 반영
  } else {
    DRAW_WIDTH = w
  }
}
styleCtl.onWidthChange = (w) => {
  styleCtl.onWidthInput?.(w)
  styleCommitted = false
  afterEdit()
}

// 글자크기: 노트만 대상. 크기가 바뀌면 natural(측정 박스)이 변하므로 updateNote 반환값으로 갱신한다.
styleCtl.onFontInput = (s) => {
  const ns = styleTargets().filter(isNoteItem)
  if (ns.length > 0) {
    if (!styleCommitted) {
      commit()
      styleCommitted = true
    }
    for (const n of ns) {
      n.fontSize = s
      const m = scene.updateNote(n)
      if (m) n.natural = m
    }
    afterEdit() // 박스 크기 변화 → 선택 외곽선/기즈모 갱신
    TEXT_FONT_SIZE = s // 마지막 크기를 다음 생성 기본값에도 반영
  } else {
    TEXT_FONT_SIZE = s
  }
}
styleCtl.onFontChange = (s) => {
  // onFontInput이 노트 분기에서 이미 afterEdit를 호출하므로 여기서 또 부르지 않는다(렌더 2배 방지).
  styleCtl.onFontInput?.(s)
  styleCommitted = false
}

// 글꼴: 노트만 대상(select라 change만, 히스토리 1회). 웹폰트는 로드 후 정확 렌더되도록 fonts.load 뒤 재측정한다.
styleCtl.onFontFamilyChange = (family) => {
  const ns = styleTargets().filter(isNoteItem)
  if (ns.length > 0) {
    commit()
    for (const n of ns) {
      n.fontFamily = family
      const m = scene.updateNote(n)
      if (m) n.natural = m
    }
    afterEdit()
    TEXT_FONT_FAMILY = family // 마지막 글꼴을 다음 생성 기본값에도 반영
    // 웹폰트가 아직 로드 전이면 폴백으로 그려졌을 수 있으니, 로드 완료 후 한 번 더 재측정/재렌더한다.
    document.fonts
      .load(`${ns[0].fontSize}px ${family}`)
      .then(() => {
        // 호출~resolve 사이 삭제됐을 수 있으니 board.items에 아직 있는 노트만 재측정(stale 참조 보정).
        const alive = ns.filter((n) => board.items.some((i) => i.id === n.id))
        if (alive.length === 0) return
        for (const n of alive) {
          const m = scene.updateNote(n)
          if (m) n.natural = m
        }
        afterEdit()
      })
      .catch(() => {})
  } else {
    TEXT_FONT_FAMILY = family
  }
}
function updateMinimap() {
  // 미니맵이 숨김이면 contentBounds()의 O(n) 계산 자체를 생략(기본값이 숨김 — perf P1).
  if (!minimap.isVisible()) return
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
    const im = getItem(ids[0])
    if (im && !im.locked) {
      // 크롭된 이미지는 표시 크기(croppedSize)로 기즈모를 그려 선택 외곽선과 일치시킨다(bug-core P1).
      // 노트/드로잉은 측정/바운딩 박스(natural) 기준.
      scene.drawGizmo(handlePositions(im.transform, itemDisplaySize(im), 30 / cam.zoom))
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
// 팬/줌은 raw 포인터/휠 이벤트마다 applyCam을 부르므로(초당 수십~수백 회) 무거운 재계산을
// rAF 1회로 코얼레싱한다. GPU 카메라 반영만 즉시 하고, 나머지(외곽선·기즈모·미니맵·그리드·
// 상태바·가상화)는 다음 프레임에 한 번만 묶어 처리해 대량 보드의 팬/줌 프리즈를 막는다(perf P1).
let camRafId = 0
function applyCamHeavy() {
  scene.drawSelection(sel.values(), lockedIdSet()) // 줌 변화에 맞춰 외곽선 두께(줌 보정) 갱신
  refreshGizmo() // 핸들 크기/오프셋도 줌 보정
  updateMinimap()
  drawGridIfOn() // 그리드도 보이는 영역 기준 재계산
  toolbar.updateStatus({ zoom: cam.zoom, selCount: sel.values().length, total: board.items.filter(isImageItem).length })
  virt.update() // 가시영역 재평가 → 텍스처 로드/언로드
}
function applyCam() {
  scene.setCamera(cam.x, cam.y, cam.zoom) // 즉시 반영(시각 반응성)
  board.camera = { ...cam }
  if (camRafId) return // 이번 프레임 갱신이 이미 예약됨 → 중복 작업 생략(코얼레싱)
  camRafId = requestAnimationFrame(() => {
    camRafId = 0
    applyCamHeavy()
  })
}
applyCam()

// 주어진 월드 경계(AABB)가 화면에 꽉 차도록 카메라를 맞춘다(pad<1 이면 여백).
function fitBounds(b: { minX: number; minY: number; maxX: number; maxY: number }, pad = 0.9) {
  const W = host.clientWidth
  const H = host.clientHeight
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(W / bw, H / bh) * pad))
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

function zoomAt(screenX: number, screenY: number, factor: number): void {
  const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * factor))
  cam.x = screenX - (screenX - cam.x) * (newZoom / cam.zoom)
  cam.y = screenY - (screenY - cam.y) * (newZoom / cam.zoom)
  cam.zoom = newZoom
  applyCam()
}

// 보드 통째 복원(열기·undo·redo 공용).
// keepCamera=true면 현재 카메라를 유지 — undo/redo가 편집과 무관하게 화면을 점프시키지 않게 한다(bug-core P1).
// 열기/크래시 복구는 저장된 카메라를 복원해야 자연스러우므로 기본은 복원이다.
async function restore(state: BoardState, opts?: { keepCamera?: boolean }) {
  const keep = opts?.keepCamera ? { ...cam } : null
  board = state
  await scene.rebuild(board.items)
  cam = keep ?? { ...board.camera }
  applyCam()
  sel.clear()
  hint.style.display = board.items.length > 0 ? 'none' : ''
  refreshBoardStatus() // 상태바 보드 이름·공유 배지 갱신(열기·복구·undo/redo·세션 공용 출구)
}

// ---- 줌: 휠(커서 위치를 고정점으로) ----
host.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const rect = host.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    zoomAt(mx, my, factor)
  },
  { passive: false },
)

attachEditorTwoFingerGestures(host, {
  onPan: (dx, dy) => {
    cam.x += dx
    cam.y += dy
    applyCam()
  },
  onPinch: (factor, centerX, centerY) => zoomAt(centerX, centerY, factor),
})

// ---- 팬: 우클릭/휠클릭 드래그 (DOM 이벤트) ----
let panning = false
let last = { x: 0, y: 0 }
let panRect: DOMRect | null = null
host.addEventListener('pointerdown', (e) => {
  if (e.button === 2 || e.button === 1) {
    panning = true
    last = { x: e.clientX, y: e.clientY }
    panRect = host.getBoundingClientRect()
    host.setPointerCapture(e.pointerId)
  }
})
host.addEventListener('pointermove', (e) => {
  if (!panning) return
  cam.x += e.clientX - last.x
  cam.y += e.clientY - last.y
  last = { x: e.clientX, y: e.clientY }
  applyCam()
  const rect = panRect ?? host.getBoundingClientRect()
  cursorReporter.report(scene.screenToWorld(e.clientX - rect.left, e.clientY - rect.top))
})
host.addEventListener('pointerup', (e) => {
  if (panning) {
    panning = false
    panRect = null
    host.releasePointerCapture(e.pointerId)
  }
})
host.addEventListener('contextmenu', (e) => e.preventDefault())
host.addEventListener('dblclick', (e) => {
  // 선택 도구에서 노트를 더블클릭하면 텍스트 재편집(포커스보다 우선).
  if (activeTool === 'select') {
    const rect = host.getBoundingClientRect()
    const w = scene.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
    const note = noteAtWorld(w.x, w.y)
    if (note && !note.locked) {
      noteEditor.open({ x: note.transform.x, y: note.transform.y }, note)
      return
    }
  }
  if (sel.size > 0 || scene.allIds().length > 0) focusSelected()
})

// 월드 좌표에 적중하는 "노트"를 위(z 큰 것)부터 찾는다(더블클릭 재편집용).
function noteAtWorld(wx: number, wy: number): BoardNote | null {
  const notes = board.items.filter((i): i is BoardNote => i.type === 'note').sort((a, b) => b.z - a.z)
  for (const n of notes) {
    const a = scene.getItemAABB(n.id)
    if (a && wx >= a.minX && wx <= a.maxX && wy >= a.minY && wy <= a.maxY) return n
  }
  return null
}

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
  // 0a) 활성 도구가 'select'가 아니면 도구별 동작으로 가로챈다(기존 선택/이동/기즈모로 진행하지 않음).
  if (activeTool === 'text') {
    // 텍스트 도구: 클릭 지점에 입력기 띄움(중심=클릭 월드좌표).
    noteEditor.open(p.world)
    return
  }
  if (activeTool === 'eraser') {
    drawingTool.eraseAt(p.hitId) // 클릭 적중 드로잉 삭제 + 이후 드래그도 onPointerMove에서 지움
    return
  }
  if (activeTool === 'eyedropper') {
    // 스포이드: 클릭 지점의 색을 추출한다. EyeDropper 지원 브라우저는 좌표 무관(화면 어디서나),
    // 폴백은 stage 픽셀에서 클릭 화면좌표의 색을 읽는다. 성공 시 스와치 표시 + 클립보드 복사.
    void pickColorAt(p)
    return
  }
  if (activeTool !== 'select') {
    // 펜/직선/사각형/타원/화살표: 드래그 시작(drawing-tool이 미리보기·확정까지 처리).
    drawingTool.begin(activeTool as DrawingTool, p.world)
    return
  }
  // 0) 크롭 모드: 대상 이미지 기준 드래그 시작점(원본픽셀) 기록
  if (cropMode && cropTargetId) {
    const im = getItem(cropTargetId)
    if (im && isImageItem(im)) {
      cropDrag = { startPix: worldToPixel(im, p.world.x, p.world.y), startWorld: p.world }
      return
    }
  }
  // 1) 변형 기즈모 핸들 우선 판정(단일 선택·비잠금)
  if (sel.size === 1) {
    const gid = sel.values()[0]
    const gim = getItem(gid)
    if (gim && !gim.locked) {
      const handles = handlePositions(gim.transform, itemDisplaySize(gim), 30 / cam.zoom)
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
      const img = getItem(id)
      if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
    }
    const rubber = maybeStartRubberDrag(origins.size, p.world, p.shift)
    if (rubber) {
      drag = rubber
      return
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
  cursorReporter.report(p.world)
  // 드로잉 도구: 드래그 중 점 수집 + 미리보기(drawing-tool이 처리).
  if (drawingTool.isActive()) {
    drawingTool.extend(p.world, p.shift)
    return
  }
  // 지우개: 버튼을 누른 채 이동하면 지나가는 드로잉을 계속 삭제(드래그 지우기).
  if (activeTool === 'eraser') {
    if (p.hitId) drawingTool.eraseAt(p.hitId)
    return
  }
  // 크롭 모드: 드래그 사각형 미리보기(월드 좌표)
  if (cropMode) {
    if (cropDrag) scene.drawRubber(rectOf(cropDrag.startWorld, p.world))
    return
  }
  if (!drag) return
  if (drag.mode === 'gizmo') {
    const gd = drag // 타입 내로잉 캡처(아래 콜백/commit 이후에도 'gizmo'로 고정)
    const im = getItem(gd.id)
    if (!im) return
    if (!gd.committed) {
      commit()
      gd.committed = true
    }
    if (gd.handle === 'rotate') {
      im.transform.rotation = rotateFromPointer(gd.t0, gd.start, p.world, p.shift).rotation
    } else {
      const r = scaleFromHandle(gd.handle, gd.t0, itemDisplaySize(im), gd.start, p.world, { centered: p.alt })
      im.transform.scale = r.scale
      im.transform.x = r.x
      im.transform.y = r.y
    }
    syncNode(im)
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
      const img = getItem(id)
      if (!img) continue
      img.transform.x = o.x + dx
      img.transform.y = o.y + dy
      syncNode(img)
    }
    // 스냅(켜졌을 때): 대표(첫) 아이템 기준 보정량을 전 선택에 적용. 이웃 우선→그리드.
    if (snapOn && drag.origins.size > 0) {
      const repId = [...drag.origins.keys()][0]
      const a = scene.getItemAABB(repId)
      if (a) {
        const thr = 8 / cam.zoom
        let adj = snapToNeighbors(a, drag.others, thr)
        if (adj.dx === 0 && adj.dy === 0) adj = snapDeltaToGrid(a.minX, a.minY, 32)
        // Shift로 한 축을 0으로 고정했으면 그 축의 스냅 보정 성분도 0으로(축 제약이 깨지지 않게).
        if (p.shift) {
          if (Math.abs(p.world.x - drag.start.x) >= Math.abs(p.world.y - drag.start.y)) adj.dy = 0
          else adj.dx = 0
        }
        if (adj.dx !== 0 || adj.dy !== 0) {
          for (const [id, o] of drag.origins) {
            const img = getItem(id)
            if (!img) continue
            img.transform.x = o.x + dx + adj.dx
            img.transform.y = o.y + dy + adj.dy
            syncNode(img)
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
  // 드로잉 도구: 드래그 종료 → BoardDrawing 확정.
  if (drawingTool.isActive()) {
    drawingTool.finish()
    return
  }
  if (activeTool === 'eraser') return // 지우개는 down/move에서 처리, up은 무시
  // 크롭 모드: 드래그 영역을 원본픽셀 크롭으로 확정(크롭 영역은 제자리 유지)
  if (cropMode) {
    if (cropDrag && cropTargetId) {
      const im = getItem(cropTargetId)
      if (im && isImageItem(im)) {
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
          syncNode(im)
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
    scene.removeItem(id) // 이미지·노트·드로잉 모두 제거(타입 무관)
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
    const src = getItem(id)
    if (!src) continue
    // 타입 무관 깊은 복사(이미지/노트/드로잉). id·z·위치만 새로 부여.
    const copy = structuredClone(src) as BoardItem
    copy.id = genId()
    copy.z = board.items.length
    copy.transform.x += 24
    copy.transform.y += 24
    board.items.push(copy)
    await scene.addItem(copy) // 타입에 맞게 sprite/text/graphics 추가
    newIds.push(copy.id)
  }
  sel.set(newIds)
  updateMinimap()
}

async function packAll() {
  const targets = sel.size > 1 ? sel.values() : scene.allIds()
  if (targets.length < 2) return
  commit()
  const items = targets.flatMap((id) => {
    const im = getItem(id)
    // scene-board desync로 board에 없는 id면 건너뛴다(비널 단언 제거 — bug-core P3).
    if (!im) return []
    return [{ id, w: im.natural.w * im.transform.scale, h: im.natural.h * im.transform.scale }]
  })
  const aspect = Math.max(0.1, host.clientWidth / host.clientHeight)
  const pos = await packImagesOffThread(items, { aspect, padding: 16 })
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  for (const id of targets) {
    const im = getItem(id)
    const p = pos.get(id)
    if (!im || !p) continue
    im.transform.x = center.x + p.x
    im.transform.y = center.y + p.y
    syncNode(im)
  }
  fitAll()
}

// z순서 변경 공통: 히스토리 적재 → 모듈 호출 → zIndex 동기화
function applyZOrder(fn: (items: BoardItem[], ids: Set<string> | string[]) => void) {
  if (sel.size === 0) return
  commit()
  fn(board.items, sel.values())
  syncZIndex()
}
function syncZIndex() {
  for (const im of board.items) {
    // getNode는 타입무관(Sprite|Text|Graphics)이라 노트·드로잉의 z순서도 시각 반영된다(getSprite는 이미지만).
    const s = scene.getNode(im.id)
    if (s) s.zIndex = im.z
  }
}

function removeItemById(id: string) {
  scene.removeItem(id)
  const idx = board.items.findIndex((item) => item.id === id)
  if (idx >= 0) board.items.splice(idx, 1)
  normalizeZ(board.items)
  syncZIndex()
}

// 좌우/상하 뒤집기 (Alt+Shift+H / Alt+Shift+V) — 비파괴(transform.flipX/Y 토글)
function flipSelected(axis: 'x' | 'y') {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    const img = getItem(id)
    if (!img) continue
    if (axis === 'x') img.transform.flipX = !img.transform.flipX
    else img.transform.flipY = !img.transform.flipY
    syncNode(img)
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
    const im = getItem(id)
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
    const im = getItem(id)
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
    const im = getItem(id)
    return im ? !im.locked : false
  })
  for (const id of ids) {
    const im = getItem(id)
    if (im) im.locked = anyUnlocked
  }
  markLockedCacheDirty()
  afterEdit()
  showToast(anyUnlocked ? '잠금' : '잠금 해제', true)
}

// ---- 그리드 (Phase 2.8) ----
// 그리드가 켜져 있으면 현재 카메라/뷰포트 기준으로 다시 계산해 그린다. 꺼져 있으면 지운다.
function drawGridIfOn() {
  if (gridOn) scene.drawGrid(visibleGrid(cam, { w: host.clientWidth, h: host.clientHeight }))
  else scene.drawGrid(null)
}

// ============================================================================
// 텍스트 / 펜·도형 드로잉 / 댓글 (Phase: 텍스트·드로잉·댓글)
// ============================================================================

// ---- 드로잉(펜/도형) 입력·지우개 → drawing-tool 모듈로 분리(7.3 God-file 분리) ----
// drawState 생명주기·미리보기 2D 캔버스·도형 확정·지우개를 createDrawingTool이 캡슐화한다.
// 포인터 핸들러는 begin/extend/finish/cancel/isActive/eraseAt만 호출한다.
const drawingTool = createDrawingTool({
  host,
  scene,
  getBoard: () => board, // restore()가 board를 재할당하므로 getter로 항상 live board 참조
  sel,
  genId,
  commit,
  updateMinimap,
  syncZIndex,
  worldToScreen,
  getZoom: () => cam.zoom,
  getDrawStyle: () => ({ color: DRAW_COLOR, width: DRAW_WIDTH }),
  hintEl: hint,
})

// ---- 스포이드(색 추출) ----
// 클릭 지점의 색을 추출한다. 추출 색은 스와치로 잠시 보여주고 클립보드(HEX)에 복사한다.
//  - EyeDropper 지원 브라우저: 좌표와 무관하게 화면 전체에서 픽킹(pickColor 내부에서 처리).
//  - 폴백: renderer.extract 대상(app.stage = 화면 전체)에서 클릭 화면좌표의 픽셀색을 읽는다.
//    ScenePointer는 월드 좌표만 주므로 worldToScreen으로 화면좌표를 복원해 넘긴다(cam 역변환).
async function pickColorAt(p: ScenePointer) {
  const sp = worldToScreen(p.world.x, p.world.y)
  try {
    const color = await pickColor({
      renderer: scene.app.renderer,
      stage: scene.app.stage, // 화면 전체 루트(world는 그 자식). 화면좌표 기준 폴백 픽킹 대상
      screenX: sp.x,
      screenY: sp.y,
    })
    if (!color) return // 사용자가 취소(EyeDropper Esc 등)
    showColorSwatch(color, sp.x, sp.y)
    await copyColor(color)
    showToast(`색 추출: ${color.hex} (복사됨)`, true)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '색 추출 실패', true)
  }
}

const noteEditor = createNoteEditor({
  host,
  scene,
  get board() { return board },
  sel,
  genId,
  commit,
  afterEdit,
  updateMinimap,
  removeItem: removeItemById,
  showToast,
  hintEl: hint,
  getTextDefaults: () => ({ color: TEXT_COLOR, fontSize: TEXT_FONT_SIZE, fontFamily: TEXT_FONT_FAMILY }),
  worldToScreen: (world) => worldToScreen(world.x, world.y),
  getZoom: () => cam.zoom,
})

// ---- 댓글(이미지에 부착하는 메모) ----
async function editComment() {
  const ids = sel.values()
  if (ids.length !== 1) {
    showToast('댓글은 이미지 1개를 선택했을 때 가능합니다', true)
    return
  }
  const im = getItem(ids[0])
  if (!im || !isImageItem(im)) {
    showToast('댓글은 이미지에만 달 수 있습니다', true)
    return
  }
  const cur = im.comment ?? ''
  const next = await openPromptDialog({
    title: '이미지 댓글 편집',
    label: '이미지 댓글(메모) · 비우면 삭제',
    initialValue: cur,
    confirmLabel: '저장',
    multiline: true,
  })
  if (next === null) return // 취소
  const trimmed = next.trim()
  commit()
  if (trimmed.length === 0) delete im.comment
  else im.comment = trimmed
  setDirty(true)
  showToast(trimmed.length === 0 ? '댓글 삭제됨' : '댓글 저장됨', true)
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
  const target = getItem(sel.values()[0])
  // 크롭은 이미지 전용(노트/드로잉은 비파괴 크롭 개념이 없다).
  if (target && !isImageItem(target)) {
    showToast('크롭은 이미지에만 적용할 수 있습니다', true)
    return
  }
  // 회전된 이미지는 화면축 드래그 사각형과 원본픽셀 크롭이 어긋나므로 차단한다(bug-core P1).
  // (변형 리셋으로 회전을 0으로 되돌린 뒤 크롭하면 된다.)
  if (target && target.transform.rotation !== 0) {
    showToast('회전된 이미지는 크롭할 수 없습니다 · 변형 리셋(Ctrl+Shift+T) 후 시도하세요', true)
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
    const im = getItem(id)
    if (!im || !isImageItem(im) || !im.crop) continue // 크롭은 이미지에만 존재
    delete im.crop
    scene.applyCrop(id, im)
    syncNode(im)
  }
  afterEdit()
}
// 변형 리셋 (Ctrl+Shift+T): scale=1·rotation=0·flip 해제 (crop·위치는 유지)
function resetTransform() {
  const ids = sel.values()
  if (ids.length === 0) return
  commit()
  for (const id of ids) {
    const im = getItem(id)
    if (!im) continue
    im.transform.scale = 1
    im.transform.rotation = 0
    im.transform.flipX = false
    im.transform.flipY = false
    syncNode(im)
  }
  afterEdit()
}

// ---- 정렬 / 분배 / 정규화 (Phase 2.4) ----
function alignItems(): AlignItem[] {
  const out: AlignItem[] = []
  for (const id of sel.values()) {
    const im = getItem(id)
    const a = scene.getItemAABB(id)
    if (im && a) out.push({ id, aabb: a, cx: im.transform.x, cy: im.transform.y, natural: im.natural, scale: im.transform.scale })
  }
  return out
}
function applyDeltas(deltas: Map<string, { dx: number; dy: number }>) {
  for (const [id, d] of deltas) {
    const im = getItem(id)
    if (!im) continue
    im.transform.x += d.dx
    im.transform.y += d.dy
    syncNode(im)
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
function doNormalize(mode: 'width' | 'height' | 'scale' | 'area') {
  const items = alignItems()
  if (items.length < 2) return
  commit()
  for (const [id, sc] of normalizeSize(items, mode)) {
    const im = getItem(id)
    if (!im) continue
    im.transform.scale = sc.scale
    syncNode(im)
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
    if (dirty) {
      const ok = await openConfirmDialog({
        title: '보드 열기',
        message: '저장하지 않은 변경이 있습니다.\n불러오면 현재 보드가 대체됩니다. 계속할까요?',
        confirmLabel: '불러오기',
        destructive: true,
      })
      if (!ok) return
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
    await restore(prev, { keepCamera: true }) // undo는 객체 상태만 되돌리고 카메라는 유지(bug-core P1)
    setDirty(true)
  }
}
async function doRedo() {
  const next = history.redo(board)
  if (next) {
    await restore(next, { keepCamera: true })
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

// ---- 개별 내보내기(Export Each): 아이템마다 파일 1장씩 ----
// 전체 또는 선택 아이템을 각각 PNG로 떨어뜨린다. 파일명=원본 name(없으면 id) + 순번.
// 동일 이름 충돌·다운로드 순번 보장을 위해 파일명 끝에 "-01" 식 인덱스를 붙인다.
async function exportEachItems(scope: 'all' | 'sel') {
  // 대상 id: 'sel'은 현재 선택, 'all'은 씬 전체. 개별 내보내기는 이미지만 의미가 있으므로
  // 이미지 아이템만 추린다(노트/드로잉은 단독 PNG 의미가 약하고 getSprite도 이미지 전용).
  const baseIds = scope === 'sel' ? sel.values() : scene.allIds()
  const ids = baseIds.filter((id) => {
    const it = getItem(id)
    return it != null && isImageItem(it)
  })
  if (ids.length === 0) {
    showToast(scope === 'sel' ? '내보낼 이미지를 선택하세요' : '내보낼 이미지가 없습니다', true)
    return
  }
  const fmt: ExportFormat = 'png' // 현재 기본 포맷(향후 설정 연동 가능)
  const restoreOverlays = scene.hideOverlays()
  try {
    showLoading(`개별 내보내기… ${ids.length}장`)
    const results = await exportEach(scene.app.renderer, scene.world, ids, (id) => scene.getSprite(id), {
      format: fmt,
      padding: 0,
    })
    if (results.length === 0) {
      showToast('내보낼 항목이 없습니다', true)
      return
    }
    // 파일명: 원본 name(없으면 id) + 0패딩 순번. 같은 이름이 여러 장이어도 순번으로 구분된다.
    const pad = String(results.length).length
    results.forEach((res, i) => {
      const im = getItem(res.id)
      const baseName = (im && isImageItem(im) && im.name ? stripExt(im.name) : res.id)
      const seq = String(i + 1).padStart(pad, '0')
      downloadBlob(res.blob, withImageExt(`${baseName}-${seq}`, fmt))
    })
    showToast(`${results.length}장을 개별 파일로 내보냈습니다`, true)
  } catch (err) {
    showToast(err instanceof Error ? err.message : '개별 내보내기 실패')
  } finally {
    restoreOverlays()
    hideLoading()
  }
}
// 파일명에서 확장자만 제거(개별 내보내기 베이스명 정리용). 점이 없으면 원본 그대로.
function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

// ---- 이전/다음 항목 순회(선택 이동 + 포커스) ----
// 현재 선택(첫 항목) 기준으로 z순서(scene.allIds, 이미 z 정렬) 인덱스를 ±1(wrap)해 선택을 옮기고
// 그 항목으로 카메라를 포커스한다. 선택이 없으면 첫(prev는 마지막) 항목으로 진입한다.
function navigateItem(dir: 1 | -1) {
  const ids = scene.allIds()
  if (ids.length === 0) return
  const curId = sel.values()[0]
  let idx = curId ? ids.indexOf(curId) : -1
  if (idx < 0) {
    // 선택이 없거나 목록에 없으면: next는 처음(0), prev는 마지막으로 진입.
    idx = dir === 1 ? 0 : ids.length - 1
  } else {
    idx = (idx + dir + ids.length) % ids.length // 순환(wrap)
  }
  const nextId = ids[idx]
  sel.set([nextId])
  focusSelected()
}

// ---- 캔버스 최적화(정돈): 전체 자동 배치 후 전체 보기 ----
// packAll은 선택이 2개 이상이면 선택만, 아니면 전체를 pack한다. "최적화"는 항상 전체를 정돈하는
// 의미이므로 선택을 비운 뒤 packAll을 호출해 전체 대상이 되게 한다(packAll 내부에서 fitAll까지 수행).
async function optimizeCanvas() {
  if (scene.allIds().length < 2) {
    showToast('정돈할 항목이 2개 이상이어야 합니다', true)
    return
  }
  sel.clear()
  await packAll() // 전체 pack + fitAll(내부에서 호출)
  showToast('캔버스를 정돈했습니다', true)
}

// ---- 기준별 격자 정렬(이름/추가순/레이어순/무작위) ----
// 같은 키를 연속 실행하면 오름/내림(reverse)을 토글한다. 무작위는 매 실행 새 시드로 다시 섞는다.
// 대상: 선택 2개 이상이면 선택, 아니면 전체(이미지·노트·드로잉 모두 — 표시 크기로 배치).
let lastSortKey: SortKey | null = null
let lastSortReverse = false
function doArrangeSort(key: SortKey) {
  const targetIds = sel.size > 1 ? sel.values() : scene.allIds()
  if (targetIds.length < 2) {
    showToast('정렬할 항목이 2개 이상이어야 합니다', true)
    return
  }
  // 같은 키 연속 실행 → reverse 토글. 다른 키면 오름차순부터 시작.
  if (key === lastSortKey && key !== 'random') {
    lastSortReverse = !lastSortReverse
  } else {
    lastSortReverse = false
  }
  lastSortKey = key
  // SortItem 매핑: 표시 크기(natural × scale)와 정렬 키 필드(name/addedAt/z).
  const items: SortItem[] = []
  for (const id of targetIds) {
    const im = getItem(id)
    if (!im) continue
    const ds = itemDisplaySize(im) // 이미지=크롭 반영, 노트/드로잉=natural
    items.push({
      id,
      name: isImageItem(im) ? im.name : undefined,
      addedAt: isImageItem(im) ? im.addedAt : undefined,
      z: im.z,
      w: ds.w * im.transform.scale,
      h: ds.h * im.transform.scale,
    })
  }
  if (items.length < 2) return
  const aspect = Math.max(0.1, host.clientWidth / host.clientHeight)
  const pos = arrangeGrid(items, key, {
    aspect,
    padding: 16,
    reverse: lastSortReverse,
    seed: key === 'random' ? Date.now() : undefined, // 무작위는 매번 새 시드
  })
  commit()
  // 반환 중심좌표(원점 기준)를 화면 중앙으로 평행이동해 적용(packAll과 동일 방식).
  const center = scene.screenToWorld(host.clientWidth / 2, host.clientHeight / 2)
  for (const id of targetIds) {
    const im = getItem(id)
    const p = pos.get(id)
    if (!im || !p) continue
    im.transform.x = center.x + p.x
    im.transform.y = center.y + p.y
    syncNode(im)
  }
  fitAll()
  const KEY_LABEL: Record<SortKey, string> = { name: '이름순', added: '추가순', order: '레이어순', random: '무작위' }
  showToast(`격자 정렬: ${KEY_LABEL[key]}${key !== 'random' && lastSortReverse ? ' (역순)' : ''}`, true)
}

// ---- 최근 파일 피커 열기 ----
// 마지막 세션 복원 + 최근 목록을 모달로 보여준다. 복원/비우기는 콜백으로 main이 처리.
function openRecentFiles() {
  openRecentPicker({
    entries: getRecent(),
    hasLastSession: getLastSession() != null,
    onRestoreLast: () => {
      const s = getLastSession()
      if (s) {
        history.push(board)
        void restore(s)
        setDirty(true)
        showToast('마지막 세션을 복원했습니다', true)
      }
    },
    onClear: clearRecent,
  })
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
// 도구(텍스트·드로잉) 전환 + 댓글 — '도구' 그룹. 한 글자 단축키(기존 바인딩과 비충돌 확인).
const TOOL_ACTIONS: Action[] = [
  { id: 'tool.select', label: '선택 도구', group: '도구', defaultCombo: 'V' },
  { id: 'tool.text', label: '텍스트 도구', group: '도구', defaultCombo: 'T' },
  { id: 'tool.pen', label: '펜 도구', group: '도구', defaultCombo: 'P' },
  { id: 'tool.line', label: '직선 도구', group: '도구', defaultCombo: 'L' },
  { id: 'tool.rect', label: '사각형 도구', group: '도구', defaultCombo: 'R' },
  { id: 'tool.ellipse', label: '타원 도구', group: '도구', defaultCombo: 'O' },
  { id: 'tool.arrow', label: '화살표 도구', group: '도구', defaultCombo: 'A' },
  { id: 'tool.eraser', label: '드로잉 지우개', group: '도구', defaultCombo: 'E' },
  // 스포이드(색 추출) 도구. S는 미사용 단일키(입력 포커스 시 keydown early-return이라 안전).
  { id: 'tool.eyedropper', label: '스포이드(색 추출)', group: '도구', defaultCombo: 'S' },
  { id: 'comment.edit', label: '이미지 댓글', group: '도구', defaultCombo: 'Alt+C' },
]
// 단축키 액션 카탈로그 등록(저장된 사용자 재바인딩도 이때 함께 로드된다).
registerActions([...DEFAULT_ACTIONS, ...WINDOW_ACTIONS, ...APP_EXTRA_ACTIONS, ...TOOL_ACTIONS])

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
// ---- 웹 공유 + 보드 관리 패널 + 원격 이미지 인라인 → share-io 모듈로 분리(7.3 God-file) ----
const shareIo = createShareIo({
  getBoard: () => board, // restore()가 board를 재할당하므로 getter로 항상 live board 참조
  restore,
  showToast,
  showLoading,
  hideLoading,
  saveNow: () => void autosave.saveNow(),
  refreshBoardStatus,
  setDirty,
  getDirty: () => dirty,
  setShareDisabled: (v) => toolbar.setDisabled('share.webLink', v),
})

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
    case 'view.optimize': void optimizeCanvas(); break
    case 'navigate.prev': navigateItem(-1); break
    case 'navigate.next': navigateItem(1); break
    // 편집
    case 'edit.selectAll': sel.set(scene.allIds()); break
    case 'edit.escape':
      if (noteEditor.isOpen()) noteEditor.cancel() // 텍스트 편집 중 → 취소
      else if (drawingTool.isActive()) drawingTool.cancel() // 드로잉 드래그 중 → 취소
      else if (cropMode) exitCropMode()
      else if (activeTool !== 'select') setActiveTool('select') // 도구 사용 중 → 선택 도구로 복귀
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
    case 'arrange.pack': void packAll(); break
    case 'arrange.group': groupSelected(); break
    case 'arrange.ungroup': ungroupSelected(); break
    case 'arrange.alignLeft': doAlign('left'); break
    case 'arrange.alignRight': doAlign('right'); break
    case 'arrange.alignTop': doAlign('top'); break
    case 'arrange.alignBottom': doAlign('bottom'); break
    case 'arrange.distributeH': doDistribute('h'); break
    case 'arrange.distributeV': doDistribute('v'); break
    case 'arrange.alignHCenter': doAlign('hcenter'); break
    case 'arrange.alignVCenter': doAlign('vcenter'); break
    case 'arrange.normWidth': doNormalize('width'); break
    case 'arrange.normHeight': doNormalize('height'); break
    case 'arrange.normScale': doNormalize('scale'); break
    case 'arrange.normArea': doNormalize('area'); break
    case 'arrange.sortName': doArrangeSort('name'); break
    case 'arrange.sortAdded': doArrangeSort('added'); break
    case 'arrange.sortOrder': doArrangeSort('order'); break
    case 'arrange.sortRandom': doArrangeSort('random'); break
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
    // 도구(텍스트·드로잉) — 활성 도구 전환
    case 'tool.select': setActiveTool('select'); break
    case 'tool.text': setActiveTool('text'); break
    case 'tool.pen': setActiveTool('pen'); break
    case 'tool.line': setActiveTool('line'); break
    case 'tool.rect': setActiveTool('rect'); break
    case 'tool.ellipse': setActiveTool('ellipse'); break
    case 'tool.arrow': setActiveTool('arrow'); break
    case 'tool.eraser': setActiveTool('eraser'); break
    case 'tool.eyedropper': setActiveTool('eyedropper'); break
    // 댓글(선택 이미지에 메모)
    case 'comment.edit': void editComment(); break
    // 파일
    case 'file.import': openImageFiles(); break
    case 'file.save': void save(); break
    case 'file.open': void openBoard(); break
    case 'file.exportScene': void exportScene(); break
    case 'file.exportSelection': void exportSel(); break
    case 'file.exportEachAll': void exportEachItems('all'); break
    case 'file.exportEachSel': void exportEachItems('sel'); break
    case 'file.recentOpen': openRecentFiles(); break
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
    case 'share.webLink': void shareIo.shareWebLink(); break
    case 'share.manage': shareIo.openBoardManagerPanel(); break
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
    // 입력 필드 포커스는 위에서 이미 return했으므로 여기 Backspace는 항상 삭제 경로다.
    // 웹뷰 뒤로가기(history back) 유발을 막기 위해 기본 동작을 차단한다.
    e.preventDefault()
    deleteSelected()
  } else if (ctrl && e.key.toLowerCase() === 'y') {
    e.preventDefault()
    void doRedo()
  }
})

// ---- 가져오기 공통 ----
type ImportedImage = { url: string; size: { w: number; h: number }; name: string }
type ImportResult = { ok: true; value: ImportedImage } | { ok: false }

async function importFiles(files: File[], baseX: number, baseY: number) {
  if (files.length === 0) return
  // 원본 파일명(name)도 함께 보관 — 정렬(격자 이름순)·개별 내보내기 파일명에 쓰인다.
  const valid: ImportedImage[] = []
  let completed = 0
  showLoading(files.length > 1 ? `이미지 불러오는 중… 0/${files.length}` : '이미지 불러오는 중…')
  const decoded = await mapWithConcurrency<File, ImportResult>(files, 6, async (file) => {
    try {
      const url = await blobToDataURL(file)
      // 대형 이미지는 자동 다운스케일(메모리·.refb 크기·렌더 성능 절감). 긴 변 4096px 초과분만 줄인다.
      // downscaleIfLarge가 결과 픽셀 크기를 함께 반환하므로 별도 imageSize 호출은 불필요.
      const ds = await downscaleIfLarge(url, { maxEdge: IMAGE_MAX_EDGE })
      // 치수를 끝내 못 구한 0×0 결과는 배치하지 않는다(렌더/바운즈/pack 깨짐 방지 — bug-io P1).
      if (ds.width <= 0 || ds.height <= 0) throw new Error('이미지 크기를 확인할 수 없습니다')
      return { ok: true, value: { url: ds.dataUrl, size: { w: ds.width, h: ds.height }, name: file.name } }
    } catch {
      return { ok: false }
    } finally {
      completed += 1
      if (files.length > 1) showLoading(`이미지 불러오는 중… ${completed}/${files.length}`)
    }
  })
  for (const result of decoded) {
    if (result.ok) valid.push(result.value)
  }
  const failed = decoded.length - valid.length
  if (valid.length > 0) {
    commit()
    for (let j = 0; j < valid.length; j++) {
      if (valid.length > 1) showLoading(`배치 중… ${j + 1}/${valid.length}`)
      const item = valid[j]
      if (!item) continue
      await placeImageWithSize(item.url, item.size, baseX + j * 30, baseY + j * 30, item.name)
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

async function placeImageWithSize(
  dataUrl: string,
  size: { w: number; h: number },
  x: number,
  y: number,
  name?: string,
) {
  const img: BoardImage = {
    id: genId(),
    type: 'image',
    src: dataUrl,
    natural: size,
    transform: { x, y, scale: 1, rotation: 0 },
    opacity: 1,
    locked: false,
    z: board.items.length,
    // 정렬(이름순)·개별 내보내기 파일명용 메타. 가져오기 경로(드롭/붙여넣기/열기/OS드롭) 공통으로 기록.
    ...(name ? { name } : {}),
    addedAt: Date.now(),
  }
  board.items.push(img)
  await scene.addImage(img)
  hint.style.display = 'none'
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
  arrangeSort: doArrangeSort, // 격자 정렬(name/added/order/random)
  optimize: optimizeCanvas, // 전체 정돈(pack+fit)
  navigate: navigateItem, // 이전/다음 순회(±1)
  exportEach: exportEachItems, // 개별 내보내기('all'|'sel')
  recentOpen: openRecentFiles, // 최근 파일 피커
  toggleSnap: () => ((snapOn = !snapOn), snapOn),
  toggleMinimap: () => (minimap.toggle(), updateMinimap()),
  undo: doUndo,
  redo: doRedo,
  save,
  exportScene,
  exportSel,
  open: openBoard,
  getItem,
}

// ---- 부팅 초기화: 크래시 복구 → 마지막 세션 이어 열기 → 자동저장 시작 ----
// 순서가 중요하다: 자동저장 start()는 복구 처리가 끝난 뒤에 호출해야 복구본을 빈 스냅샷이 덮지 않는다.
function loadLastSessionIfAny() {
  if (board.items.length > 0) return // 이미 내용이 있으면 건드리지 않음
  const last = getLastSession()
  if (last && last.items.length > 0) {
    void restore(last)
      .then(() => showToast('마지막 세션을 불러왔습니다', true))
      .catch((err: unknown) => {
        console.warn('[recent] 마지막 세션 복원 실패', err)
        showToast('마지막 세션을 불러오지 못했습니다.')
      })
  }
}
void (async () => {
  try {
    if (await autosave.hasRecovery()) {
      const ts = await autosave.getRecoveryTimestamp()
      const when = ts ? new Date(ts).toLocaleString() : '이전'
      const ok = await openConfirmDialog({
        title: '자동저장 복구',
        message: `비정상 종료로 저장되지 않은 작업이 있습니다(${when}).\n복구하시겠습니까?`,
        confirmLabel: '복구',
      })
      if (ok) {
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
