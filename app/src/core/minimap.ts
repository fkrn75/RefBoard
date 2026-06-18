// 미니맵 오버레이 — 화면 우하단에 전체 보드의 축소도 + 현재 뷰포트 사각형을 표시.
//
// 설계 원칙:
//  - Scene/PixiJS에 의존하지 않는 독립 클래스. 자체 HTMLCanvasElement(2D)를 host에
//    position:absolute로 우하단에 얹는다. scene.ts는 건드리지 않는다(단일 writer는 main).
//  - 카메라 규약은 scene.ts와 동일하다: world.position=(cam.x, cam.y), world.scale=cam.zoom.
//    즉 화면좌표→월드좌표 역변환은  worldX = (screenX - cam.x) / cam.zoom  (Y도 동일).
//  - 좌표 변환만 책임지고, 실제 카메라 이동은 onJump 콜백으로 main에 위임한다.

// 전체 아이템 합집합 경계(월드 좌표). contentBounds() 산출물과 동일 형태.
export interface MinimapBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

// 현재 카메라 상태(scene.camera와 동일 형태).
export interface MinimapCamera {
  x: number
  y: number
  zoom: number
}

// ---- 시각 상수 ----
const MM_W = 200 // 미니맵 가로(px)
const MM_H = 150 // 미니맵 세로(px)
const MM_MARGIN = 12 // 우/하 여백(px)
const MM_PAD = 8 // 내부 여백 — 콘텐츠가 테두리에 붙지 않도록(px)

export class Minimap {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private visible = true

  // 마지막 update 값 — 클릭 시 월드좌표 역산에 필요하므로 보관한다.
  private bounds: MinimapBounds | null = null

  // 월드→미니맵 매핑 파라미터(letterbox). drawContent 시 갱신, 클릭 역산 시 사용.
  // mmX = contentX + (worldX - bounds.minX) * scale
  private mapScale = 1
  private contentX = MM_PAD // 콘텐츠 영역 좌상단 오프셋(letterbox 적용 후)
  private contentY = MM_PAD

  // 미니맵 클릭 시 해당 월드좌표를 통지(없으면 무시). 카메라 이동은 main 담당.
  onJump?: (worldX: number, worldY: number) => void

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas')
    // 고해상도 디스플레이 대응: 내부 버퍼는 DPR 배율, CSS 표시는 논리 px.
    const dpr = globalThis.devicePixelRatio || 1
    canvas.width = MM_W * dpr
    canvas.height = MM_H * dpr
    canvas.style.position = 'absolute'
    canvas.style.right = `${MM_MARGIN}px`
    canvas.style.bottom = `${MM_MARGIN}px`
    canvas.style.width = `${MM_W}px`
    canvas.style.height = `${MM_H}px`
    canvas.style.cursor = 'pointer'
    canvas.style.borderRadius = '4px'
    canvas.style.zIndex = '50' // 캔버스 위, 일반 UI와 충돌하지 않는 선
    canvas.style.pointerEvents = 'auto'

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Minimap: 2D 컨텍스트를 가져올 수 없습니다')
    this.ctx = ctx
    // 모든 그리기를 논리 px(MM_W×MM_H) 좌표로 다루도록 DPR 배율을 한 번만 적용.
    this.ctx.scale(dpr, dpr)

    canvas.addEventListener('pointerdown', this.handlePointerDown)
    host.appendChild(canvas)
    this.canvas = canvas
  }

  // 전체 보드 경계·카메라·뷰포트 픽셀 크기를 받아 미니맵을 다시 그린다.
  // bounds=null(빈 캔버스)이면 배경만 그린다.
  update(bounds: MinimapBounds | null, cam: MinimapCamera, vw: number, vh: number): void {
    this.bounds = bounds
    if (!this.visible) return

    const ctx = this.ctx
    // 배경(반투명) — 매 프레임 클리어 후 다시 칠한다.
    ctx.clearRect(0, 0, MM_W, MM_H)
    ctx.fillStyle = 'rgba(20, 20, 20, 0.78)'
    ctx.fillRect(0, 0, MM_W, MM_H)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, MM_W - 1, MM_H - 1)

    if (!bounds) return

    // ---- letterbox: bounds(월드)를 내부 콘텐츠 영역에 종횡비 유지로 맞춤 ----
    const availW = MM_W - MM_PAD * 2
    const availH = MM_H - MM_PAD * 2
    let bw = bounds.maxX - bounds.minX
    let bh = bounds.maxY - bounds.minY
    // 폭/높이가 0(아이템 1개 등 퇴화 경우)이면 1로 보정해 0 나눗셈 방지.
    if (bw <= 0) bw = 1
    if (bh <= 0) bh = 1

    const scale = Math.min(availW / bw, availH / bh)
    this.mapScale = scale
    // 실제 콘텐츠가 차지하는 크기와, 남는 공간을 반씩 나눈 letterbox 오프셋.
    const drawW = bw * scale
    const drawH = bh * scale
    this.contentX = MM_PAD + (availW - drawW) / 2
    this.contentY = MM_PAD + (availH - drawH) / 2

    // (1) bounds 전체를 옅은 박스로 표시(콘텐츠가 존재하는 영역).
    ctx.fillStyle = 'rgba(120, 160, 210, 0.22)'
    ctx.fillRect(this.contentX, this.contentY, drawW, drawH)
    ctx.strokeStyle = 'rgba(120, 160, 210, 0.45)'
    ctx.lineWidth = 1
    ctx.strokeRect(this.contentX, this.contentY, drawW, drawH)

    // (2) 현재 화면에 보이는 뷰포트를 밝은 테두리로 오버레이.
    //     화면 (0,0)~(vw,vh)를 월드좌표로 역산: worldX=(screenX-cam.x)/cam.zoom.
    const zoom = cam.zoom || 1 // 0 보호
    const viewMinX = (0 - cam.x) / zoom
    const viewMinY = (0 - cam.y) / zoom
    const viewMaxX = (vw - cam.x) / zoom
    const viewMaxY = (vh - cam.y) / zoom

    const vx = this.worldToMmX(viewMinX)
    const vy = this.worldToMmY(viewMinY)
    const vrw = (viewMaxX - viewMinX) * scale
    const vrh = (viewMaxY - viewMinY) * scale
    ctx.strokeStyle = 'rgba(74, 163, 255, 0.95)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(vx, vy, vrw, vrh)
  }

  // 표시/숨김 설정. 숨기면 canvas를 DOM에서 감추기만 한다(상태는 유지).
  setVisible(v: boolean): void {
    this.visible = v
    this.canvas.style.display = v ? 'block' : 'none'
  }

  // 표시 상태 토글.
  toggle(): void {
    this.setVisible(!this.visible)
  }

  // 현재 표시 여부 — main의 updateMinimap이 숨김 상태면 contentBounds() O(n) 계산을 생략하는 데 쓴다(perf P1).
  isVisible(): boolean {
    return this.visible
  }

  // 리스너 해제 + canvas 제거.
  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.remove()
  }

  // ---- 내부 좌표 변환 ----

  // 월드 X → 미니맵 논리 px.
  private worldToMmX(worldX: number): number {
    const b = this.bounds
    if (!b) return this.contentX
    return this.contentX + (worldX - b.minX) * this.mapScale
  }

  // 월드 Y → 미니맵 논리 px.
  private worldToMmY(worldY: number): number {
    const b = this.bounds
    if (!b) return this.contentY
    return this.contentY + (worldY - b.minY) * this.mapScale
  }

  // 미니맵 클릭 → 월드좌표 역산 → onJump 통지.
  private handlePointerDown = (e: PointerEvent): void => {
    if (!this.bounds || !this.onJump || this.mapScale <= 0) return
    // canvas 내부 논리 px 좌표(CSS 크기 기준이라 DPR 보정 불필요).
    const rect = this.canvas.getBoundingClientRect()
    const mmX = e.clientX - rect.left
    const mmY = e.clientY - rect.top
    // worldToMm의 역함수: worldX = minX + (mmX - contentX) / scale.
    const worldX = this.bounds.minX + (mmX - this.contentX) / this.mapScale
    const worldY = this.bounds.minY + (mmY - this.contentY) / this.mapScale
    this.onJump(worldX, worldY)
  }
}
