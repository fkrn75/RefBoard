// 드로잉(펜·직선·사각형·타원·화살표) 입력·미리보기·확정·지우개를 캡슐화한 모듈.
// main.ts God-file 분리(7.3)의 일환. drawState 생명주기와 미리보기용 2D 캔버스를 자체 소유하고,
// 포인터 핸들러는 begin/extend/finish/cancel/isActive/eraseAt만 호출한다.
// (scene=PixiJS는 직접 수정 금지라, 드래그 중 임시 도형은 host 위에 얹은 별도 2D 캔버스에 그린다.)
import { normalizeZ } from './zorder'
import type { BoardDrawing, BoardState, DrawingTool } from './board'
import type { Scene } from './scene'
import type { Selection } from './selection'

type Pt = { x: number; y: number }

export interface DrawingToolDeps {
  host: HTMLElement
  scene: Scene
  getBoard: () => BoardState
  sel: Selection
  genId: () => string
  commit: () => void
  updateMinimap: () => void
  syncZIndex: () => void
  // 월드 좌표 → 화면(미리보기 캔버스) 좌표. main의 카메라 기준 변환을 주입한다.
  worldToScreen: (wx: number, wy: number) => Pt
  getZoom: () => number
  // "다음 생성" 기본 스타일(색·굵기). StyleControl로 실시간 변경되므로 매번 조회한다.
  getDrawStyle: () => { color: string; width: number }
  hintEl: HTMLElement
}

export interface DrawingToolApi {
  begin(tool: DrawingTool, world: Pt): void
  extend(world: Pt, shift: boolean): void
  finish(): void
  cancel(): void
  isActive(): boolean
  eraseAt(hitId: string | null): void
  resize(): void
  dispose(): void
}

// 순수: 수집된 점 → BoardDrawing의 기하 정보(바운딩박스 + 중심 정규화). 너무 작으면(클릭 수준) null.
// genId·color·width·z는 호출부가 채운다(부수효과 없는 기하 계산만 분리해 단위테스트 가능).
export function buildDrawingGeometry(
  tool: DrawingTool,
  rawPoints: Pt[],
  zoom: number,
): { points: Pt[]; natural: { w: number; h: number }; transform: Pt } | null {
  let pts = rawPoints
  if (pts.length === 0) return null
  // line/arrow/rect/ellipse는 시작·끝 2점만 의미가 있다(중간 이동 흔적 제거).
  if (tool !== 'pen' && pts.length >= 2) pts = [pts[0], pts[pts.length - 1]]
  // 바운딩박스 산출.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  let w = maxX - minX
  let h = maxY - minY
  // 너무 작은(클릭 수준) 드래그는 도형으로 만들지 않는다.
  const tiny = 3 / zoom
  if (tool !== 'pen' && w < tiny && h < tiny) return null
  if (tool === 'pen' && pts.length < 2) return null
  // 선(수평/수직)·점은 박스가 0이 될 수 있어 최소 1로 보정(natural=0이면 AABB/기즈모가 깨짐).
  w = Math.max(w, 1)
  h = Math.max(h, 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  // 중심 기준 로컬 좌표로 정규화.
  const local = pts.map((p) => ({ x: p.x - cx, y: p.y - cy }))
  return { points: local, natural: { w, h }, transform: { x: cx, y: cy } }
}

export function createDrawingTool(deps: DrawingToolDeps): DrawingToolApi {
  // 드래그하는 동안 월드 좌표 점을 모은다. 펜=연속점, line/rect/ellipse/arrow=시작·끝 2점만 갱신.
  let drawState: { tool: DrawingTool; points: Pt[] } | null = null

  // 미리보기 오버레이(2D 캔버스): host 위에 얹어 드래그 중 임시 도형을 그린다.
  const previewCanvas = document.createElement('canvas')
  previewCanvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:40'
  deps.host.appendChild(previewCanvas)
  const previewCtx = previewCanvas.getContext('2d')

  const resize = (): void => {
    const dpr = globalThis.devicePixelRatio || 1
    previewCanvas.width = Math.round(deps.host.clientWidth * dpr)
    previewCanvas.height = Math.round(deps.host.clientHeight * dpr)
    previewCanvas.style.width = deps.host.clientWidth + 'px'
    previewCanvas.style.height = deps.host.clientHeight + 'px'
    if (previewCtx) previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  window.addEventListener('resize', resize)

  const clearPreview = (): void => {
    if (previewCtx) previewCtx.clearRect(0, 0, deps.host.clientWidth, deps.host.clientHeight)
  }

  // 화살표(직선 + 머리) 경로를 2D 컨텍스트에 그린다(미리보기 전용).
  const drawArrowPath = (
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    w: number,
  ): void => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    const ang = Math.atan2(y2 - y1, x2 - x1)
    const head = Math.max(10, w * 3) // 머리 길이(화면 px)
    const spread = Math.PI / 7
    ctx.beginPath()
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(ang - spread), y2 - head * Math.sin(ang - spread))
    ctx.moveTo(x2, y2)
    ctx.lineTo(x2 - head * Math.cos(ang + spread), y2 - head * Math.sin(ang + spread))
    ctx.stroke()
  }

  // 현재 drawState를 화면 미리보기 캔버스에 그린다(월드→화면 변환, 화면 픽셀 굵기).
  const render = (): void => {
    if (!previewCtx || !drawState) return
    clearPreview()
    const pts = drawState.points
    if (pts.length === 0) return
    const sp = pts.map((p) => deps.worldToScreen(p.x, p.y))
    const { color, width } = deps.getDrawStyle()
    const zoom = deps.getZoom()
    previewCtx.save()
    previewCtx.strokeStyle = color
    previewCtx.fillStyle = color
    previewCtx.lineWidth = Math.max(1, width * zoom)
    previewCtx.lineCap = 'round'
    previewCtx.lineJoin = 'round'
    const a = sp[0]
    const b = sp[sp.length - 1]
    previewCtx.beginPath()
    if (drawState.tool === 'pen') {
      previewCtx.moveTo(a.x, a.y)
      for (let i = 1; i < sp.length; i++) previewCtx.lineTo(sp[i].x, sp[i].y)
      previewCtx.stroke()
    } else if (drawState.tool === 'line') {
      previewCtx.moveTo(a.x, a.y)
      previewCtx.lineTo(b.x, b.y)
      previewCtx.stroke()
    } else if (drawState.tool === 'rect') {
      previewCtx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    } else if (drawState.tool === 'ellipse') {
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      previewCtx.ellipse(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
      previewCtx.stroke()
    } else if (drawState.tool === 'arrow') {
      drawArrowPath(previewCtx, a.x, a.y, b.x, b.y, Math.max(1, width * zoom))
    }
    previewCtx.restore()
  }

  const cancel = (): void => {
    drawState = null
    clearPreview()
  }

  return {
    begin(tool, world) {
      drawState = { tool, points: [{ x: world.x, y: world.y }] }
      render()
    },
    extend(world, shift) {
      if (!drawState) return
      if (drawState.tool === 'pen') {
        drawState.points.push({ x: world.x, y: world.y })
      } else {
        // 2점 도형: 끝점만 갱신(시작점 유지). Shift=수평/수직/45° 제약.
        let ex = world.x
        let ey = world.y
        if (shift) {
          const s0 = drawState.points[0]
          const dx = ex - s0.x
          const dy = ey - s0.y
          if (drawState.tool === 'line' || drawState.tool === 'arrow') {
            // 가장 가까운 45° 방향으로 스냅.
            const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
            const len = Math.hypot(dx, dy)
            ex = s0.x + Math.cos(ang) * len
            ey = s0.y + Math.sin(ang) * len
          } else {
            // rect/ellipse: 정사각형/정원(짧은 변에 맞춤).
            const m = Math.min(Math.abs(dx), Math.abs(dy))
            ex = s0.x + Math.sign(dx) * m
            ey = s0.y + Math.sign(dy) * m
          }
        }
        drawState.points = [drawState.points[0], { x: ex, y: ey }]
      }
      render()
    },
    finish() {
      if (!drawState) return
      const tool = drawState.tool
      const rawPoints = drawState.points
      cancel()
      const geo = buildDrawingGeometry(tool, rawPoints, deps.getZoom())
      if (!geo) return
      const { color, width } = deps.getDrawStyle()
      const board = deps.getBoard()
      const d: BoardDrawing = {
        id: deps.genId(),
        type: 'drawing',
        tool,
        points: geo.points,
        color,
        width,
        natural: geo.natural,
        transform: { x: geo.transform.x, y: geo.transform.y, scale: 1, rotation: 0 },
        opacity: 1,
        locked: false,
        z: board.items.length,
      }
      deps.commit()
      board.items.push(d)
      deps.scene.addDrawing(d) // 동기(Graphics 반환)
      deps.hintEl.style.display = 'none'
      deps.sel.set([d.id]) // 그린 직후 선택 → 바로 이동/변형 가능
      deps.updateMinimap()
    },
    cancel,
    isActive() {
      return drawState !== null
    },
    // 지우개: 적중한 "드로잉" 아이템만 삭제(이미지·노트는 보존).
    eraseAt(hitId) {
      if (!hitId) return
      const board = deps.getBoard()
      const idx = board.items.findIndex((i) => i.id === hitId)
      if (idx < 0) return
      if (board.items[idx].type !== 'drawing') return
      deps.commit()
      deps.scene.removeItem(hitId)
      board.items.splice(idx, 1)
      normalizeZ(board.items)
      deps.syncZIndex()
      deps.sel.clear()
      deps.updateMinimap()
      if (board.items.length === 0) deps.hintEl.style.display = ''
    },
    resize,
    dispose() {
      window.removeEventListener('resize', resize)
      previewCanvas.remove()
    },
  }
}
