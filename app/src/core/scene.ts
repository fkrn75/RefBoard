import { Application, Container, Graphics, Sprite, Texture, Assets, type FederatedPointerEvent } from 'pixi.js'
import type { BoardImage } from './board'

// 화면 입력 1건을 "월드 좌표 + 적중 아이템"으로 정규화한 형태.
export interface ScenePointer {
  world: { x: number; y: number }
  hitId: string | null // 클릭된 이미지 id (빈 곳이면 null)
  button: number
  shift: boolean
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

  // 입력 콜백 (main이 주입)
  onPointerDown?: (p: ScenePointer) => void
  onPointerMove?: (p: ScenePointer) => void
  onPointerUp?: (p: ScenePointer) => void

  private constructor(app: Application) {
    this.app = app
    this.world = new Container()
    this.world.sortableChildren = true // zIndex로 레이어 순서 정렬
    this.app.stage.addChild(this.world)

    // 오버레이 레이어: 항상 최상단, 포인터 이벤트는 통과(none)
    for (const layer of [this.selLayer, this.rubberLayer]) {
      layer.eventMode = 'none'
      this.world.addChild(layer)
    }
    this.selLayer.zIndex = 1_000_000
    this.rubberLayer.zIndex = 1_000_001

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
    return { world: { x: w.x, y: w.y }, hitId, button: e.button, shift: e.shiftKey }
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
    const texture: Texture = await Assets.load(img.src)
    const sprite = new Sprite(texture)
    sprite.anchor.set(0.5) // 중심 기준 배치/스케일/회전
    sprite.eventMode = 'static' // 포인터 적중 대상
    sprite.cursor = 'grab'
    sprite.label = img.id // 적중 시 id 식별용
    this.applyTransform(sprite, img)
    this.world.addChild(sprite)
    this.sprites.set(img.id, sprite)
    return sprite
  }

  // 보드 데이터의 변형값을 스프라이트에 반영(비파괴: 원본 텍스처 불변)
  applyTransform(sprite: Sprite, img: BoardImage) {
    sprite.position.set(img.transform.x, img.transform.y)
    sprite.scale.set(img.transform.scale)
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

  // ---- 오버레이 그리기 ----
  drawSelection(ids: string[]) {
    this.selLayer.clear()
    const lw = 2 / this.world.scale.x // 화면상 2px 유지(줌 보정)
    for (const id of ids) {
      const s = this.sprites.get(id)
      if (!s) continue
      this.selLayer.poly(this.corners(s)).stroke({ width: lw, color: 0x4aa3ff })
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
}
