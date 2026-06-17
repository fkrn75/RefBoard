import { Application, Container, Graphics, Sprite, Texture, Assets, Rectangle, type FederatedPointerEvent } from 'pixi.js'
import { AnimatedGIF } from '@pixi/gif'
import type { BoardImage } from './board'
import type { GizmoHandle } from './gizmo'
import { cropToFrame } from './crop'
import type { GridLines } from './grid'

// 화면 입력 1건을 "월드 좌표 + 적중 아이템"으로 정규화한 형태.
export interface ScenePointer {
  world: { x: number; y: number }
  hitId: string | null // 클릭된 이미지 id (빈 곳이면 null)
  button: number
  shift: boolean
  alt: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// PixiJS(WebGL) 기반 무한 캔버스 렌더러.
// world 컨테이너 1개를 이동/스케일해 무한 캔버스 + 줌/팬을 구현한다.
// 좌표·적중 판정은 Scene이 책임지고, 선택/이동 "로직"은 main이 콜백으로 담당한다.
export class Scene {
  readonly app: Application
  readonly world: Container
  private sprites = new Map<string, Sprite>()
  private selLayer = new Graphics() // 선택 외곽선
  private rubberLayer = new Graphics() // 러버밴드 사각형
  private gizmoLayer = new Graphics() // 변형 기즈모 핸들
  private gridLayer = new Graphics() // 배경 그리드(최하단)

  // 입력 콜백 (main이 주입)
  onPointerDown?: (p: ScenePointer) => void
  onPointerMove?: (p: ScenePointer) => void
  onPointerUp?: (p: ScenePointer) => void

  private constructor(app: Application) {
    this.app = app
    this.world = new Container()
    this.world.sortableChildren = true // zIndex로 레이어 순서 정렬
    this.app.stage.addChild(this.world)

    // 배경 그리드: 최하단(이미지보다 아래), 포인터 통과
    this.gridLayer.eventMode = 'none'
    this.gridLayer.zIndex = -1_000_000
    this.world.addChild(this.gridLayer)

    // 오버레이 레이어: 항상 최상단, 포인터 이벤트는 통과(none)
    for (const layer of [this.selLayer, this.rubberLayer, this.gizmoLayer]) {
      layer.eventMode = 'none'
      this.world.addChild(layer)
    }
    this.selLayer.zIndex = 1_000_000
    this.rubberLayer.zIndex = 1_000_001
    this.gizmoLayer.zIndex = 1_000_002

    // stage 전역 포인터 입력 → 정규화 후 콜백으로 전달
    const stage = this.app.stage
    stage.eventMode = 'static'
    stage.hitArea = this.app.screen
    stage.on('pointerdown', (e) => this.onPointerDown?.(this.toPointer(e)))
    stage.on('pointermove', (e) => this.onPointerMove?.(this.toPointer(e)))
    stage.on('pointerup', (e) => this.onPointerUp?.(this.toPointer(e)))
    stage.on('pointerupoutside', (e) => this.onPointerUp?.(this.toPointer(e)))
  }

  // FederatedPointerEvent → ScenePointer (적중 아이템은 e.target.label로 식별)
  private toPointer(e: FederatedPointerEvent): ScenePointer {
    const t = e.target
    const hitId =
      t && t !== this.app.stage && typeof t.label === 'string' && t.label.length > 0 ? t.label : null
    const w = this.world.toLocal(e.global)
    return { world: { x: w.x, y: w.y }, hitId, button: e.button, shift: e.shiftKey, alt: e.altKey }
  }

  static async create(host: HTMLElement): Promise<Scene> {
    const app = new Application()
    await app.init({
      background: '#1e1e1e',
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: globalThis.devicePixelRatio || 1,
    })
    host.appendChild(app.canvas)
    return new Scene(app)
  }

  // ---- 카메라 ----
  setCamera(x: number, y: number, zoom: number) {
    this.world.scale.set(zoom)
    this.world.position.set(x, y)
  }
  get camera() {
    return { x: this.world.position.x, y: this.world.position.y, zoom: this.world.scale.x }
  }
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return this.world.toLocal({ x: sx, y: sy })
  }

  // ---- 이미지 ----
  async addImage(img: BoardImage): Promise<Sprite> {
    let sprite: Sprite
    if (Scene.isGif(img.src)) {
      // GIF: src(data URL/경로)를 ArrayBuffer로 받아 독립 AnimatedGIF 생성(autoPlay·autoUpdate 기본 true → 자동 재생).
      // Assets.load는 src 단위로 캐시해 같은 GIF가 한 인스턴스를 공유(복제 시 부모 충돌)하므로 fromBuffer로 매번 새로 만든다.
      const buf = await (await fetch(img.src)).arrayBuffer()
      sprite = AnimatedGIF.fromBuffer(buf)
    } else {
      const texture: Texture = await Assets.load(img.src)
      sprite = new Sprite(texture)
    }
    sprite.anchor.set(0.5) // 중심 기준 배치/스케일/회전
    sprite.eventMode = 'static' // 포인터 적중 대상
    sprite.cursor = 'grab'
    sprite.label = img.id // 적중 시 id 식별용
    this.applyTransform(sprite, img)
    this.world.addChild(sprite)
    this.sprites.set(img.id, sprite)
    if (img.crop) this.applyCrop(img.id, img) // 저장본/복원 시 크롭 반영
    return sprite
  }

  // crop(원본 픽셀 사각형) 반영 — 공유 source는 유지하고 frame만 교체(비파괴). GIF는 미지원.
  // crop이 없으면 원본 전체 frame으로 되돌린다(크롭 리셋 경로).
  applyCrop(id: string, img: BoardImage) {
    const sprite = this.sprites.get(id)
    if (!sprite || sprite instanceof AnimatedGIF) return
    const f = cropToFrame(img.crop, img.natural)
    sprite.texture = new Texture({ source: sprite.texture.source, frame: new Rectangle(f.x, f.y, f.w, f.h) })
  }

  // src가 GIF인지 판별(data URL 또는 .gif 확장자)
  private static isGif(src: string): boolean {
    return /^data:image\/gif/i.test(src) || /\.gif(\?|$)/i.test(src)
  }

  // 보드 데이터의 변형값을 스프라이트에 반영(비파괴: 원본 텍스처 불변)
  applyTransform(sprite: Sprite, img: BoardImage) {
    sprite.position.set(img.transform.x, img.transform.y)
    // flip은 scale 부호로 반영(비파괴). corners()는 abs(scale)이라 경계/기즈모 계산엔 영향 없음.
    const sx = img.transform.scale * (img.transform.flipX ? -1 : 1)
    const sy = img.transform.scale * (img.transform.flipY ? -1 : 1)
    sprite.scale.set(sx, sy)
    sprite.rotation = img.transform.rotation
    sprite.alpha = img.opacity
    sprite.zIndex = img.z
  }

  getSprite(id: string): Sprite | undefined {
    return this.sprites.get(id)
  }
  allIds(): string[] {
    return [...this.sprites.keys()]
  }

  // 모든 스프라이트 커서 일괄 변경(이동 드래그 중 'grabbing' 등). 신규 스프라이트 기본값은 addImage의 'grab'.
  setCursor(cursor: string) {
    for (const s of this.sprites.values()) s.cursor = cursor
  }

  // 스프라이트 제거(텍스처/리소스 해제). board.items 정리는 호출측 책임.
  removeImage(id: string): boolean {
    const s = this.sprites.get(id)
    if (!s) return false
    s.destroy()
    this.sprites.delete(id)
    return true
  }

  // 보드 전체를 비우고 새 items로 다시 그림(저장본 열기·Undo 복원용).
  async rebuild(items: BoardImage[]) {
    for (const id of [...this.sprites.keys()]) this.removeImage(id)
    for (const img of items) await this.addImage(img)
  }

  // ---- 경계 계산 (회전·스케일 고려한 월드 4코너) ----
  private corners(s: Sprite): { x: number; y: number }[] {
    const hw = (s.texture.width / 2) * Math.abs(s.scale.x)
    const hh = (s.texture.height / 2) * Math.abs(s.scale.y)
    const cos = Math.cos(s.rotation)
    const sin = Math.sin(s.rotation)
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => ({ x: s.x + x * cos - y * sin, y: s.y + x * sin + y * cos }))
  }

  // 러버밴드 교차 판정용 축 정렬 경계상자(AABB)
  getItemAABB(id: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const s = this.sprites.get(id)
    if (!s) return null
    const c = this.corners(s)
    const xs = c.map((p) => p.x)
    const ys = c.map((p) => p.y)
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
  }

  // 모든 아이템의 합집합 경계(전체 보기 fit-all용). 빈 캔버스면 null.
  contentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const id of this.sprites.keys()) {
      const a = this.getItemAABB(id)
      if (!a) continue
      if (a.minX < minX) minX = a.minX
      if (a.minY < minY) minY = a.minY
      if (a.maxX > maxX) maxX = a.maxX
      if (a.maxY > maxY) maxY = a.maxY
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
  }

  // ---- 오버레이 그리기 ----
  drawSelection(ids: string[], lockedIds?: Set<string>) {
    this.selLayer.clear()
    const lw = 2 / this.world.scale.x // 화면상 2px 유지(줌 보정)
    for (const id of ids) {
      const s = this.sprites.get(id)
      if (!s) continue
      // 잠긴 항목은 주황, 일반은 파랑으로 외곽선 색 구분
      const color = lockedIds?.has(id) ? 0xff9800 : 0x4aa3ff
      this.selLayer.poly(this.corners(s)).stroke({ width: lw, color })
    }
  }

  // 배경 그리드 그리기(월드 좌표 라인). null이면 끄기(clear).
  // 라인 끝점은 현재 보이는 월드 영역으로 잡아 화면 전체를 가로지르게 한다.
  // PixiJS v8 규약: stroke()는 직전 stroke/fill 이후 쌓인 path만 칠하므로 minor/major를 분리해 색을 달리한다.
  drawGrid(lines: GridLines | null) {
    this.gridLayer.clear()
    if (!lines) return
    const tl = this.screenToWorld(0, 0)
    const br = this.screenToWorld(this.app.screen.width, this.app.screen.height)
    const minX = Math.min(tl.x, br.x)
    const maxX = Math.max(tl.x, br.x)
    const minY = Math.min(tl.y, br.y)
    const maxY = Math.max(tl.y, br.y)
    const z = this.world.scale.x
    // minor 라인(얇게)
    for (const x of lines.verticals) this.gridLayer.moveTo(x, minY).lineTo(x, maxY)
    for (const y of lines.horizontals) this.gridLayer.moveTo(minX, y).lineTo(maxX, y)
    this.gridLayer.stroke({ width: 1 / z, color: 0x2c2c2c })
    // major 라인(약간 굵고 밝게)
    for (const x of lines.majorVerticals) this.gridLayer.moveTo(x, minY).lineTo(x, maxY)
    for (const y of lines.majorHorizontals) this.gridLayer.moveTo(minX, y).lineTo(maxX, y)
    this.gridLayer.stroke({ width: 1.5 / z, color: 0x3a3a3a })
  }

  // 변형 기즈모 핸들 그리기(단일 선택 시). 핸들 크기는 화면 고정(줌 보정).
  drawGizmo(handles: GizmoHandle[]) {
    this.gizmoLayer.clear()
    if (handles.length === 0) return
    const z = this.world.scale.x
    const r = 5 / z // 핸들 반경(화면 5px)
    const lw = 1.5 / z
    for (const h of handles) {
      if (h.id === 'rotate') {
        this.gizmoLayer.circle(h.x, h.y, r).fill({ color: 0xffffff }).stroke({ width: lw, color: 0x4aa3ff })
      } else {
        this.gizmoLayer.rect(h.x - r, h.y - r, r * 2, r * 2).fill({ color: 0xffffff }).stroke({ width: lw, color: 0x4aa3ff })
      }
    }
  }

  drawRubber(rect: Rect | null) {
    this.rubberLayer.clear()
    if (!rect) return
    const lw = 1 / this.world.scale.x
    this.rubberLayer
      .rect(rect.x, rect.y, rect.w, rect.h)
      .fill({ color: 0x4aa3ff, alpha: 0.12 })
      .stroke({ width: lw, color: 0x4aa3ff })
  }

  // 내보내기용: 오버레이(선택 외곽선/러버밴드/기즈모/그리드)를 잠시 숨기고 복원 함수를 반환한다.
  // renderer.extract는 받은 컨테이너를 그대로 렌더하므로, 추출 전 오버레이를 끄고 추출 후 복원해야
  // 결과 이미지에 UI 요소가 섞이지 않는다. 반환된 함수를 추출 직후 반드시 호출할 것.
  hideOverlays(): () => void {
    const layers = [this.selLayer, this.rubberLayer, this.gizmoLayer, this.gridLayer]
    const prev = layers.map((l) => l.visible)
    for (const l of layers) l.visible = false
    return () => {
      layers.forEach((l, i) => (l.visible = prev[i]))
    }
  }
}
