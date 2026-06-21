import { Application, Container, Graphics, Sprite, Text, Texture, Assets, Rectangle, type FederatedPointerEvent } from 'pixi.js'
import { AnimatedGIF } from '@pixi/gif'
import type { BoardImage, BoardItem, BoardNote, BoardDrawing } from './board'
import { isImageItem, isNoteItem, isDrawingItem } from './board'
import type { GizmoHandle } from './gizmo'
import { cropToFrame, croppedSize } from './crop'
import type { GridLines } from './grid'
import { getCanvasColors } from './theme'

// 화면 입력 1건을 "월드 좌표 + 적중 아이템"으로 정규화한 형태.
export interface ScenePointer {
  world: { x: number; y: number }
  hitId: string | null // 클릭된 아이템 id (빈 곳이면 null) — 이미지/노트/드로잉 공통
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

// 한 아이템을 화면에 표시하는 PixiJS 디스플레이 오브젝트.
//  - 이미지: Sprite(또는 AnimatedGIF)
//  - 노트  : Text
//  - 드로잉: Graphics
// 모두 Container를 상속하므로 position/scale/rotation/alpha/zIndex를 공유한다.
// AABB·기즈모·선택 외곽선은 "natural(고유 박스) × |scale|" 기반으로 일반화해 한 경로로 처리한다.
type ItemNode = Sprite | Text | Graphics

// 디스플레이 오브젝트의 회전 전 "고유 박스(natural) 크기"를 보관하는 보조 메타.
//  - 이미지: 크롭 반영 표시 픽셀(= croppedSize). texture.width와 수학적으로 같지만, 축소
//    텍스처(srcs.medium) 보정(k)을 scale에 싣는 구조라 natural을 따로 들고 있어야 일관된다.
//  - 노트/드로잉: board 모델의 natural(측정/바운딩 박스 크기).
// corners()/AABB/기즈모가 모두 이 natural을 기준으로 계산한다(이미지 결과는 종전과 불변).
interface NodeMeta {
  node: ItemNode
  natural: { w: number; h: number } // 회전 전 박스(월드, scale=1 기준)
  // 논리 scale = transform.scale. 이미지의 축소텍스처 보정(k)은 표시 배율(node.scale)에만 싣고
  // 경계 계산에는 제외한다 → 경계 반폭/반높이 = natural × scale (gizmo.ts handlePositions와 동일식).
  // 이렇게 해야 크롭+srcs 이미지에서도 종전(texture.width×node.scale) 경계와 정확히 일치한다(회귀 0).
  scale: number
}

// PixiJS(WebGL) 기반 무한 캔버스 렌더러.
// world 컨테이너 1개를 이동/스케일해 무한 캔버스 + 줌/팬을 구현한다.
// 좌표·적중 판정은 Scene이 책임지고, 선택/이동 "로직"은 main이 콜백으로 담당한다.
export class Scene {
  readonly app: Application
  readonly world: Container
  // 모든 아이템(이미지/노트/드로잉)의 디스플레이 오브젝트 + 고유 박스 메타를 한 맵으로 관리한다.
  // 키=board item id. 이미지 전용 보조 접근(getSprite 등)은 여기서 타입 좁혀 제공한다.
  private nodes = new Map<string, NodeMeta>()
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
      background: getCanvasColors().canvasBg,
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

  // ---- 공통 노드 등록/배치 헬퍼 ----
  // 디스플레이 오브젝트의 공통 입력 속성(적중 대상·id 라벨)을 세팅한다.
  private wireNode(node: ItemNode, id: string, cursor = 'grab') {
    node.eventMode = 'static' // 포인터 적중 대상
    node.cursor = cursor
    node.label = id // 적중 시 id 식별용
  }

  // transform(중심 위치·스케일·회전·flip·alpha·z)을 디스플레이 오브젝트에 반영하는 공통 경로.
  //  - extraScale: 이미지의 축소 텍스처 보정(k) 같은 추가 배율(노트/드로잉은 1).
  //  - flip은 scale 부호로 반영(비파괴). corners()는 |scale| 기반이라 경계/기즈모엔 영향 없음.
  private applyNodeTransform(node: ItemNode, it: BoardItem, extraScale = 1) {
    const t = it.transform
    node.position.set(t.x, t.y)
    const sx = t.scale * extraScale * (t.flipX ? -1 : 1)
    const sy = t.scale * extraScale * (t.flipY ? -1 : 1)
    node.scale.set(sx, sy)
    node.rotation = t.rotation
    node.alpha = it.opacity
    node.zIndex = it.z
    // 이미 등록된 노드면 논리 scale(k·flip 제외)을 갱신해 경계 계산이 최신 변형을 반영하게 한다.
    const m = this.nodes.get(it.id)
    if (m) m.scale = t.scale
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
      // 보드 뷰는 medium(다중해상도)을 우선 로드 — 없으면 원본 src 폴백(편집 보드·하위호환).
      // 원본 풀해상도는 뷰어 라이트박스가 srcs.orig로 따로 띄운다(scene은 medium까지만).
      const texture: Texture = await Assets.load(img.srcs?.medium ?? img.src)
      sprite = new Sprite(texture)
    }
    sprite.anchor.set(0.5) // 중심 기준 배치/스케일/회전
    this.wireNode(sprite, img.id)
    this.applyTransform(sprite, img)
    this.world.addChild(sprite)
    // 고유 박스(natural)=크롭 반영 표시 픽셀. corners()/AABB가 이를 기준으로 계산해
    // 종전 texture.width 기반 경계와 수학적으로 동일하다(회귀 0).
    this.registerNode(img.id, sprite, croppedSize(img.crop, img.natural), img.transform.scale)
    if (img.crop) this.applyCrop(img.id, img) // 저장본/복원 시 크롭 반영
    return sprite
  }

  // crop(원본 픽셀 사각형) 반영 — 공유 source는 유지하고 frame만 교체(비파괴). GIF는 미지원.
  // crop이 없으면 원본 전체 frame으로 되돌린다(크롭 리셋 경로).
  applyCrop(id: string, img: BoardImage) {
    const sprite = this.getSprite(id)
    if (!sprite || sprite instanceof AnimatedGIF) return
    const f = cropToFrame(img.crop, img.natural)
    sprite.texture = new Texture({ source: sprite.texture.source, frame: new Rectangle(f.x, f.y, f.w, f.h) })
    // 크롭으로 표시 픽셀이 바뀌면 고유 박스(natural)도 갱신해 AABB/기즈모가 새 크롭을 반영한다.
    this.setNodeNatural(id, croppedSize(img.crop, img.natural))
  }

  // src가 GIF인지 판별(data URL 또는 .gif 확장자)
  private static isGif(src: string): boolean {
    return /^data:image\/gif/i.test(src) || /\.gif(\?|$)/i.test(src)
  }

  // 보드 데이터의 변형값을 스프라이트에 반영(비파괴: 원본 텍스처 불변)
  applyTransform(sprite: Sprite, img: BoardImage) {
    // 축소 텍스처(srcs.medium 등) 보정: 실픽셀(texture.width)이 원본(natural.w)보다 작으면
    // 그 비율 k만큼 키워 같은 월드 크기로 보이게 한다. corners()/AABB/gizmo는 natural 기반이라
    // 이미지의 고유 박스 크기와 정합한다. srcs 없는(편집·하위호환) 보드는 k=1로 무영향.
    const texW = sprite.texture.width
    const k = img.srcs && texW > 0 ? img.natural.w / texW : 1
    this.applyNodeTransform(sprite, img, k)
  }

  // ---- 노트(텍스트) ----
  // 임시 Text로 렌더 크기를 측정한다(보드에 추가하지 않음). board.note.natural 채우기용.
  measureNote(text: string, fontSize: number, color: string): { w: number; h: number } {
    const t = new Text({ text: text.length > 0 ? text : ' ', style: this.noteStyle(fontSize, color) })
    const w = Math.max(1, Math.ceil(t.width))
    const h = Math.max(1, Math.ceil(t.height))
    t.destroy()
    return { w, h }
  }

  // 노트를 보드에 추가. anchor 0.5(중심 기준) → 이미지와 동일 배치 모델 → 기즈모 자동 편입.
  addNote(note: BoardNote): Text {
    const t = new Text({ text: note.text, style: this.noteStyle(note.fontSize, note.color) })
    t.anchor.set(0.5) // 중심 기준 배치/스케일/회전
    this.wireNode(t, note.id, 'text')
    this.applyNodeTransform(t, note)
    this.world.addChild(t)
    this.registerNode(note.id, t, note.natural, note.transform.scale)
    return t
  }

  // 노트 내용/스타일/변형 갱신. text·fontSize·color가 바뀌면 Text를 다시 그려 natural을 갱신한다.
  // 반환값: 갱신된 측정 크기(호출측이 board.note.natural에 반영하도록). 없는 id면 null.
  updateNote(note: BoardNote): { w: number; h: number } | null {
    const t = this.getNote(note.id)
    if (!t) return null
    t.text = note.text
    t.style = this.noteStyle(note.fontSize, note.color)
    const natural = { w: Math.max(1, Math.ceil(t.width)), h: Math.max(1, Math.ceil(t.height)) }
    this.applyNodeTransform(t, note)
    this.setNodeNatural(note.id, natural)
    return natural
  }

  // 노트 공통 텍스트 스타일. wordWrap 미사용(고유 박스=한 줄/입력 개행 그대로 측정).
  private noteStyle(fontSize: number, color: string) {
    return {
      fontFamily: 'Pretendard, -apple-system, "Malgun Gothic", sans-serif',
      fontSize,
      fill: color,
      align: 'left' as const,
    }
  }

  // ---- 드로잉(펜/도형) ----
  // 드로잉을 보드에 추가. points는 "고유 박스 중심(0,0)" 로컬좌표 → Graphics는 position/scale/rotation만 배치.
  addDrawing(d: BoardDrawing): Graphics {
    const g = new Graphics()
    this.paintDrawing(g, d)
    this.wireNode(g, d.id)
    this.applyNodeTransform(g, d)
    this.world.addChild(g)
    this.registerNode(d.id, g, d.natural, d.transform.scale)
    return g
  }

  // 드로잉 path/스타일/변형 갱신. tool·points·color·width가 바뀌면 path를 다시 그린다.
  updateDrawing(d: BoardDrawing): boolean {
    const g = this.getDrawing(d.id)
    if (!g) return false
    this.paintDrawing(g, d)
    this.applyNodeTransform(g, d)
    this.setNodeNatural(d.id, d.natural)
    return true
  }

  // 도구별 path를 Graphics에 그린다(로컬 좌표=고유 박스 중심 기준).
  //  - pen   : moveTo + 연속 lineTo
  //  - line  : 두 점 직선
  //  - arrow : 두 점 직선 + 끝점에 화살촉(양 날개)
  //  - rect  : 대각 두 점으로 사각형
  //  - ellipse: 대각 두 점의 중심/반지름으로 타원
  // 선폭(width)은 scale=1 기준 px. 월드 확대는 transform.scale이 담당(stroke도 같이 두꺼워짐).
  private paintDrawing(g: Graphics, d: BoardDrawing) {
    g.clear()
    const pts = d.points
    const color = d.color
    const width = Math.max(0.1, d.width)
    const stroke = { width, color, cap: 'round' as const, join: 'round' as const }

    if (d.tool === 'pen') {
      if (pts.length === 0) return
      g.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
      g.stroke(stroke)
      return
    }

    // 나머지 도구는 시작·끝(또는 대각) 2점을 사용. 점이 부족하면 그리지 않는다.
    if (pts.length < 2) return
    const a = pts[0]
    const b = pts[pts.length - 1]

    if (d.tool === 'line' || d.tool === 'arrow') {
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke(stroke)
      if (d.tool === 'arrow') {
        // 화살촉: 선 방향 기준 ±150°로 뻗은 두 날개. 길이는 선폭에 비례하되 최소치 보장.
        const ang = Math.atan2(b.y - a.y, b.x - a.x)
        const head = Math.max(8, width * 3)
        const wing = Math.PI * (5 / 6) // 150°
        g.moveTo(b.x, b.y)
          .lineTo(b.x + Math.cos(ang + wing) * head, b.y + Math.sin(ang + wing) * head)
          .moveTo(b.x, b.y)
          .lineTo(b.x + Math.cos(ang - wing) * head, b.y + Math.sin(ang - wing) * head)
          .stroke(stroke)
      }
      return
    }

    if (d.tool === 'rect') {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      const w = Math.abs(b.x - a.x)
      const h = Math.abs(b.y - a.y)
      g.rect(x, y, w, h).stroke(stroke)
      return
    }

    if (d.tool === 'ellipse') {
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const rx = Math.abs(b.x - a.x) / 2
      const ry = Math.abs(b.y - a.y) / 2
      g.ellipse(cx, cy, rx, ry).stroke(stroke)
      return
    }
  }

  // ---- 통합 추가/재구성 ----
  // 아이템 1건을 타입에 맞게 추가(이미지만 비동기 디코드, 나머지는 동기지만 Promise로 통일).
  async addItem(it: BoardItem): Promise<ItemNode> {
    if (isImageItem(it)) return this.addImage(it)
    if (isNoteItem(it)) return this.addNote(it)
    if (isDrawingItem(it)) return this.addDrawing(it)
    // 유니온 확장 시 컴파일 타임에 누락을 잡는다(절대 도달하지 않음).
    return ((_x: never) => Promise.reject(new Error('unknown item type')))(it)
  }

  // 보드 전체를 비우고 새 items로 다시 그림(저장본 열기·Undo 복원용). 이미지/노트/드로잉 혼재 지원.
  async rebuild(items: BoardItem[]) {
    for (const id of [...this.nodes.keys()]) this.removeItem(id)
    // 병렬 디코드 — 순차 await는 열기·Undo·Redo에서 전체 재디코드가 직렬이라 대량 보드에서 느리다(perf P2).
    // z 순서는 node.zIndex(applyNodeTransform) + world.sortableChildren이 보장하므로 추가 순서는 무관하다.
    await Promise.all(items.map((it) => this.addItem(it)))
  }

  // ---- 노드 맵 관리(내부) ----
  private registerNode(id: string, node: ItemNode, natural: { w: number; h: number }, scale: number) {
    this.nodes.set(id, { node, natural, scale })
  }
  private setNodeNatural(id: string, natural: { w: number; h: number }) {
    const m = this.nodes.get(id)
    if (m) m.natural = natural
  }

  // ---- 접근자 ----
  // 이미지 전용 접근(기존 호출부 호환). 노트/드로잉 id면 undefined.
  getSprite(id: string): Sprite | undefined {
    const n = this.nodes.get(id)?.node
    return n instanceof Sprite ? n : undefined
  }
  // 노트 전용 접근.
  getNote(id: string): Text | undefined {
    const n = this.nodes.get(id)?.node
    return n instanceof Text ? n : undefined
  }
  // 드로잉 전용 접근. (Graphics는 selLayer 등 오버레이도 같은 타입이지만, nodes 맵엔 아이템만 등록된다)
  getDrawing(id: string): Graphics | undefined {
    const n = this.nodes.get(id)?.node
    return n instanceof Graphics ? n : undefined
  }
  // 타입 무관 디스플레이 오브젝트 접근(공통 처리용).
  getNode(id: string): ItemNode | undefined {
    return this.nodes.get(id)?.node
  }
  allIds(): string[] {
    return [...this.nodes.keys()]
  }

  // 모든 아이템 커서 일괄 변경(이동 드래그 중 'grabbing' 등). 신규 노드 기본값은 wireNode의 'grab'.
  setCursor(cursor: string) {
    for (const m of this.nodes.values()) m.node.cursor = cursor
  }

  // 아이템 제거(텍스처/리소스 해제). board.items 정리는 호출측 책임. 타입 무관(이미지/노트/드로잉).
  removeItem(id: string): boolean {
    const m = this.nodes.get(id)
    if (!m) return false
    m.node.destroy()
    this.nodes.delete(id)
    return true
  }

  // 하위호환 별칭 — 기존 호출부(main.ts removeImage)가 그대로 동작하도록 유지. 내부는 removeItem.
  removeImage(id: string): boolean {
    return this.removeItem(id)
  }

  // ---- 경계 계산 (회전·스케일 고려한 월드 4코너) ----
  // 고유 박스(natural) × |scale| 을 반폭/반높이로 삼아 회전·평행이동한다.
  //  - 이미지: natural=croppedSize, scale=transform.scale(축소텍스처 보정 k는 표시에만 실리고
  //    natural이 이미 표시 픽셀이라 경계는 종전 texture.width 기반과 수학적으로 동일 → 회귀 0).
  //  - 노트/드로잉: natural=측정/바운딩 박스. flip은 |scale|이라 경계에 영향 없음.
  private cornersOf(meta: NodeMeta): { x: number; y: number }[] {
    const node = meta.node
    // 반폭/반높이 = natural × |scale| / 2. scale은 논리값(k·flip 제외)이라 gizmo.ts handlePositions와
    // 동일식 → 기즈모 핸들과 선택 외곽선이 항상 일치한다. (flip은 박스 크기에 영향 없음)
    const hw = (meta.natural.w / 2) * Math.abs(meta.scale)
    const hh = (meta.natural.h / 2) * Math.abs(meta.scale)
    const cos = Math.cos(node.rotation)
    const sin = Math.sin(node.rotation)
    const cx = node.position.x
    const cy = node.position.y
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => ({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos }))
  }

  // 러버밴드 교차 판정용 축 정렬 경계상자(AABB). 이미지/노트/드로잉 공통.
  getItemAABB(id: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const m = this.nodes.get(id)
    if (!m) return null
    const c = this.cornersOf(m)
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
    for (const id of this.nodes.keys()) {
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
    const c = getCanvasColors()
    const lw = 2 / this.world.scale.x // 화면상 2px 유지(줌 보정)
    for (const id of ids) {
      const m = this.nodes.get(id)
      if (!m) continue
      // 잠긴 항목은 주황(warn), 일반은 파랑(selection)으로 외곽선 색 구분(테마 연동)
      const color = lockedIds?.has(id) ? c.warn : c.selection
      this.selLayer.poly(this.cornersOf(m)).stroke({ width: lw, color })
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
    const c = getCanvasColors()
    // minor 라인(얇게)
    for (const x of lines.verticals) this.gridLayer.moveTo(x, minY).lineTo(x, maxY)
    for (const y of lines.horizontals) this.gridLayer.moveTo(minX, y).lineTo(maxX, y)
    this.gridLayer.stroke({ width: 1 / z, color: c.grid })
    // major 라인(약간 굵고 밝게)
    for (const x of lines.majorVerticals) this.gridLayer.moveTo(x, minY).lineTo(x, maxY)
    for (const y of lines.majorHorizontals) this.gridLayer.moveTo(minX, y).lineTo(maxX, y)
    this.gridLayer.stroke({ width: 1.5 / z, color: c.gridMajor })
  }

  // 변형 기즈모 핸들 그리기(단일 선택 시). 핸들 크기는 화면 고정(줌 보정).
  drawGizmo(handles: GizmoHandle[]) {
    this.gizmoLayer.clear()
    if (handles.length === 0) return
    const z = this.world.scale.x
    const c = getCanvasColors()
    const r = 5 / z // 핸들 반경(화면 5px)
    const lw = 1.5 / z
    for (const h of handles) {
      if (h.id === 'rotate') {
        this.gizmoLayer.circle(h.x, h.y, r).fill({ color: 0xffffff }).stroke({ width: lw, color: c.accent })
      } else {
        this.gizmoLayer.rect(h.x - r, h.y - r, r * 2, r * 2).fill({ color: 0xffffff }).stroke({ width: lw, color: c.accent })
      }
    }
  }

  drawRubber(rect: Rect | null) {
    this.rubberLayer.clear()
    if (!rect) return
    const c = getCanvasColors()
    const lw = 1 / this.world.scale.x
    this.rubberLayer
      .rect(rect.x, rect.y, rect.w, rect.h)
      .fill({ color: c.accent, alpha: 0.12 })
      .stroke({ width: lw, color: c.accent })
  }

  // 테마 변경 시 캔버스 배경색을 갱신한다(그리드/선택 등 오버레이는 호출측이 다시 그린다).
  refreshBackground() {
    this.app.renderer.background.color = getCanvasColors().canvasBg
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
