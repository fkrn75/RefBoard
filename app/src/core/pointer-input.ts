// 캔버스 포인터 상호작용(선택·이동·러버밴드·기즈모 변형·크롭 드래그)을 캡슐화한 모듈.
// main.ts God-file 분리(7.3). scene.onPointerDown/Move/Up을 배선하고 drag 상태머신을 내부 소유한다.
// 도구 모드(텍스트/드로잉/지우개/스포이드)는 main이 만든 핸들러(noteEditor/drawingTool/pickColorAt)로 위임하고,
// 크롭 모드 진입/해제·좌표변환은 main에 남아 deps로 주입된다(cropDrag는 exitCropMode가 리셋하므로 main 소유).
import { handlePositions, hitTest, scaleFromHandle, rotateFromPointer, type HandleId } from './gizmo'
import { snapToNeighbors, snapDeltaToGrid, type AABB } from './snap'
import { maybeStartRubberDrag, type RubberDragState } from './selection-drag'
import { expandByGroup } from './group'
import { cropRectFromDrag } from './crop'
import { isImageItem, type BoardImage, type BoardItem, type BoardState, type Transform, type DrawingTool } from './board'
import type { Scene, ScenePointer, Rect } from './scene'
import type { Selection } from './selection'
import type { NoteEditorApi } from './note-editor'
import type { DrawingToolApi } from './drawing-tool'

type Pt = { x: number; y: number }
type CropDrag = { startPix: Pt; startWorld: Pt } | null

// 드래그 상태머신: 이동 / 러버밴드(selection-drag) / 기즈모 변형. null=드래그 중 아님.
type DragState =
  | { mode: 'move'; start: Pt; origins: Map<string, Pt>; committed: boolean; others: AABB[] }
  | RubberDragState
  | { mode: 'gizmo'; handle: HandleId; id: string; t0: Transform; start: Pt; committed: boolean }
  | null

export interface PointerInputDeps {
  scene: Scene
  getBoard: () => BoardState
  sel: Selection
  getItem: (id: string) => BoardItem | undefined
  getZoom: () => number
  host: HTMLElement
  commit: () => void
  afterEdit: () => void
  syncNode: (item: BoardItem) => void
  updateMinimap: () => void
  itemDisplaySize: (item: BoardItem) => { w: number; h: number }
  getActiveTool: () => string
  getCanvasLocked: () => boolean
  getSnapOn: () => boolean
  noteEditor: NoteEditorApi
  drawingTool: DrawingToolApi
  pickColorAt: (p: ScenePointer) => void
  cursorReport: (world: Pt) => void
  // 크롭(진입/해제·대상·드래그상태는 main이 관리 — pointer는 접근자로만 다룬다)
  getCropMode: () => boolean
  getCropTargetId: () => string | null
  getCropDrag: () => CropDrag
  setCropDrag: (v: CropDrag) => void
  exitCropMode: () => void
  worldToPixel: (im: BoardImage, wx: number, wy: number) => Pt
  pixelToWorld: (im: BoardImage, px: number, py: number) => Pt
}

export interface PointerInputApi {
  // Esc 등으로 진행 중인 드래그를 취소(drag 상태 초기화). main의 escapeAction에서 호출.
  cancelDrag(): void
}

export function createPointerInput(deps: PointerInputDeps): PointerInputApi {
  let drag: DragState = null

  const rectOf = (a: Pt, b: Pt): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  })

  deps.scene.onPointerDown = (p: ScenePointer) => {
    if (deps.getCanvasLocked()) return // 캔버스 잠금 중에는 편집(선택/이동/변형) 차단 — 팬·줌·단축키는 유지
    if (p.button !== 0) return // 좌클릭만 (우클릭은 팬)
    const activeTool = deps.getActiveTool()
    // 0a) 활성 도구가 'select'가 아니면 도구별 동작으로 가로챈다(기존 선택/이동/기즈모로 진행하지 않음).
    if (activeTool === 'text') {
      deps.noteEditor.open(p.world) // 텍스트 도구: 클릭 지점에 입력기 띄움
      return
    }
    if (activeTool === 'eraser') {
      deps.drawingTool.eraseAt(p.hitId) // 클릭 적중 드로잉 삭제 + 이후 드래그도 onPointerMove에서 지움
      return
    }
    if (activeTool === 'eyedropper') {
      deps.pickColorAt(p) // 스포이드: 클릭 지점의 색 추출
      return
    }
    if (activeTool !== 'select') {
      // 펜/직선/사각형/타원/화살표: 드래그 시작(drawing-tool이 미리보기·확정까지 처리).
      deps.drawingTool.begin(activeTool as DrawingTool, p.world)
      return
    }
    // 0) 크롭 모드: 대상 이미지 기준 드래그 시작점(원본픽셀) 기록
    const cropTargetId = deps.getCropTargetId()
    if (deps.getCropMode() && cropTargetId) {
      const im = deps.getItem(cropTargetId)
      if (im && isImageItem(im)) {
        deps.setCropDrag({ startPix: deps.worldToPixel(im, p.world.x, p.world.y), startWorld: p.world })
        return
      }
    }
    // 1) 변형 기즈모 핸들 우선 판정(단일 선택·비잠금)
    if (deps.sel.size === 1) {
      const gid = deps.sel.values()[0]
      const gim = deps.getItem(gid)
      if (gim && !gim.locked) {
        const handles = handlePositions(gim.transform, deps.itemDisplaySize(gim), 30 / deps.getZoom())
        const hit = hitTest(p.world, handles, 9 / deps.getZoom())
        if (hit) {
          drag = { mode: 'gizmo', handle: hit, id: gid, t0: { ...gim.transform }, start: p.world, committed: false }
          deps.host.style.cursor = hit === 'rotate' ? 'grabbing' : 'nwse-resize'
          return
        }
      }
    }
    // 2) 이미지 선택 + 이동 (그룹 멤버 클릭 시 그룹 통째 선택)
    if (p.hitId) {
      if (p.shift) deps.sel.toggle(p.hitId)
      else if (!deps.sel.has(p.hitId)) deps.sel.set(expandByGroup(deps.getBoard().items, [p.hitId]))
      const origins = new Map<string, Pt>()
      for (const id of deps.sel.values()) {
        const img = deps.getItem(id)
        if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
      }
      const rubber = maybeStartRubberDrag(origins.size, p.world, p.shift)
      if (rubber) {
        drag = rubber
        return
      }
      const others: AABB[] = []
      for (const id of deps.scene.allIds()) {
        if (origins.has(id)) continue
        const a = deps.scene.getItemAABB(id)
        if (a) others.push(a)
      }
      drag = { mode: 'move', start: p.world, origins, committed: false, others }
      deps.host.style.cursor = 'grabbing'
      deps.scene.setCursor('grabbing')
    } else {
      // 3) 빈 곳 → 러버밴드
      if (!p.shift) deps.sel.clear()
      drag = { mode: 'rubber', start: p.world, additive: p.shift }
    }
  }

  deps.scene.onPointerMove = (p: ScenePointer) => {
    deps.cursorReport(p.world)
    // 드로잉 도구: 드래그 중 점 수집 + 미리보기(drawing-tool이 처리).
    if (deps.drawingTool.isActive()) {
      deps.drawingTool.extend(p.world, p.shift)
      return
    }
    // 지우개: 버튼을 누른 채 이동하면 지나가는 드로잉을 계속 삭제(드래그 지우기).
    if (deps.getActiveTool() === 'eraser') {
      if (p.hitId) deps.drawingTool.eraseAt(p.hitId)
      return
    }
    // 크롭 모드: 드래그 사각형 미리보기(월드 좌표)
    if (deps.getCropMode()) {
      const cd = deps.getCropDrag()
      if (cd) deps.scene.drawRubber(rectOf(cd.startWorld, p.world))
      return
    }
    if (!drag) return
    if (drag.mode === 'gizmo') {
      const gd = drag // 타입 내로잉 캡처(아래 콜백/commit 이후에도 'gizmo'로 고정)
      const im = deps.getItem(gd.id)
      if (!im) return
      if (!gd.committed) {
        deps.commit()
        gd.committed = true
      }
      if (gd.handle === 'rotate') {
        im.transform.rotation = rotateFromPointer(gd.t0, gd.start, p.world, p.shift).rotation
      } else {
        const r = scaleFromHandle(gd.handle, gd.t0, deps.itemDisplaySize(im), gd.start, p.world, { centered: p.alt })
        im.transform.scale = r.scale
        im.transform.x = r.x
        im.transform.y = r.y
      }
      deps.syncNode(im)
      deps.afterEdit()
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
        deps.commit()
        drag.committed = true
      }
      for (const [id, o] of drag.origins) {
        const img = deps.getItem(id)
        if (!img) continue
        img.transform.x = o.x + dx
        img.transform.y = o.y + dy
        deps.syncNode(img)
      }
      // 스냅(켜졌을 때): 대표(첫) 아이템 기준 보정량을 전 선택에 적용. 이웃 우선→그리드.
      if (deps.getSnapOn() && drag.origins.size > 0) {
        const repId = [...drag.origins.keys()][0]
        const a = deps.scene.getItemAABB(repId)
        if (a) {
          const thr = 8 / deps.getZoom()
          let adj = snapToNeighbors(a, drag.others, thr)
          if (adj.dx === 0 && adj.dy === 0) adj = snapDeltaToGrid(a.minX, a.minY, 32)
          // Shift로 한 축을 0으로 고정했으면 그 축의 스냅 보정 성분도 0으로(축 제약이 깨지지 않게).
          if (p.shift) {
            if (Math.abs(p.world.x - drag.start.x) >= Math.abs(p.world.y - drag.start.y)) adj.dy = 0
            else adj.dx = 0
          }
          if (adj.dx !== 0 || adj.dy !== 0) {
            for (const [id, o] of drag.origins) {
              const img = deps.getItem(id)
              if (!img) continue
              img.transform.x = o.x + dx + adj.dx
              img.transform.y = o.y + dy + adj.dy
              deps.syncNode(img)
            }
          }
        }
      }
      deps.afterEdit()
    } else if (drag.mode === 'rubber') {
      deps.scene.drawRubber(rectOf(drag.start, p.world))
    }
  }

  deps.scene.onPointerUp = (p: ScenePointer) => {
    // 드로잉 도구: 드래그 종료 → BoardDrawing 확정.
    if (deps.drawingTool.isActive()) {
      deps.drawingTool.finish()
      return
    }
    if (deps.getActiveTool() === 'eraser') return // 지우개는 down/move에서 처리, up은 무시
    // 크롭 모드: 드래그 영역을 원본픽셀 크롭으로 확정(크롭 영역은 제자리 유지)
    if (deps.getCropMode()) {
      const cd = deps.getCropDrag()
      const cropTargetId = deps.getCropTargetId()
      if (cd && cropTargetId) {
        const im = deps.getItem(cropTargetId)
        if (im && isImageItem(im)) {
          const endPix = deps.worldToPixel(im, p.world.x, p.world.y)
          const nc = cropRectFromDrag(cd.startPix, endPix, im.natural)
          if (nc.w > 4 && nc.h > 4) {
            // 크롭 영역 중심의 현재 월드 위치 → 크롭 후 그 점이 새 중심이 되게(제자리 유지)
            const wc = deps.pixelToWorld(im, nc.x + nc.w / 2, nc.y + nc.h / 2)
            deps.commit()
            im.crop = nc
            im.transform.x = wc.x
            im.transform.y = wc.y
            deps.scene.applyCrop(im.id, im)
            deps.syncNode(im)
            deps.afterEdit()
          }
        }
      }
      deps.exitCropMode() // cropMode/cropTargetId/cropDrag 초기화는 main이 담당
      return
    }
    if (!drag) return
    if (drag.mode === 'rubber') {
      const r = rectOf(drag.start, p.world)
      const hits = deps.scene.allIds().filter((id) => {
        const a = deps.scene.getItemAABB(id)
        return a !== null && !(a.maxX < r.x || a.minX > r.x + r.w || a.maxY < r.y || a.minY > r.y + r.h)
      })
      // 러버밴드에 걸린 항목을 그룹 단위로 확장
      const expanded = expandByGroup(deps.getBoard().items, hits)
      if (drag.additive) for (const id of expanded) deps.sel.add(id)
      else deps.sel.set(expanded)
      deps.scene.drawRubber(null)
    } else if (drag.mode === 'move') {
      deps.host.style.cursor = ''
      deps.scene.setCursor('grab')
      deps.updateMinimap()
    } else if (drag.mode === 'gizmo') {
      deps.host.style.cursor = ''
      deps.updateMinimap()
    }
    drag = null
  }

  return {
    cancelDrag: () => {
      drag = null
    },
  }
}
