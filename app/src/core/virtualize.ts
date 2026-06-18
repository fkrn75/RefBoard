// 가상화/언로드 + 스트레스 테스트 (Phase 4.6) — 대량 이미지 성능.
//
// 목적: 카메라 가시영역에서 충분히 벗어난 이미지의 PixiJS GPU 텍스처를 언로드(VRAM 절감)하고,
//      다시 가까워지면 재로드한다. 보드의 원본 src(data URL)는 절대 건드리지 않는다(재로드 가능 보장).
//
// 설계 원칙(단일 writer / scene 비의존):
//  - 이 모듈은 Scene/Sprite/PixiJS에 직접 의존하지 않는다. "가시영역 안에 들어오는 id 집합"만 계산하고,
//    실제 GPU 텍스처 로드/언로드는 onLoad/onUnload 콜백으로 위임한다(통합 시 team-lead가 scene에 연결).
//  - 이렇게 하면 scene.ts 무수정 제약을 지키면서, 언로드 "정책"(판정·히스테리시스)과 "구현"(GPU 조작)을 분리한다.
//
// 권장 onLoad/onUnload 구현(통합 가이드 참고):
//  - onUnload(id): const s = scene.getSprite(id); if (s) { s.visible = false; s.texture.source.unload() }
//      → texture.source.unload()는 GPU 메모리만 해제하고 CPU 데이터/래퍼는 유지하므로, 보드 src와 무관하게 안전.
//  - onLoad(id):   const s = scene.getSprite(id); if (s) s.visible = true
//      → PixiJS v8은 visible 스프라이트가 렌더에 필요해지면 source를 GPU에 자동 재업로드한다(별도 재로드 코드 불필요).
//  ※ GIF(AnimatedGIF)는 texture.source가 프레임마다 갱신되어 unload 효과가 제한적이므로, onUnload에서 제외하거나
//    visible 토글만 적용하는 것을 권장(통합 가이드의 "GIF 주의" 절 참고).

// virtualize가 판정에 필요로 하는 아이템 최소 정보(월드 중심 + 표시 크기).
// scene/board에 의존하지 않도록 호출측(getItems)이 이 형태로 투영해 넘긴다.
export interface VItem {
  id: string
  // 월드 좌표계 중심(= board.items[].transform.x/y).
  cx: number
  cy: number
  // 회전/플립 무시한 "표시 크기"(월드 단위). natural * scale 로 충분(히스테리시스 margin이 회전 오차를 흡수).
  w: number
  h: number
}

// 월드 좌표계 사각형(가시영역). x,y=좌상단, w,h=폭/높이(>0).
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface VirtualizerOptions {
  // 현재 보드 아이템들의 가상화 판정용 투영을 반환(매 update 호출 시 최신 상태를 읽음).
  getItems: () => VItem[]
  // 현재 카메라의 가시 월드 영역을 반환(통합 가이드의 getViewBounds 계산법 참고).
  getViewBounds: () => Rect
  // 가시영역(+로드 마진) 안으로 들어와 GPU 텍스처가 필요해진 아이템. 멱등하게 호출(이미 로드된 것도 다시 올 수 있음 → 내부에서 중복 억제).
  onLoad: (id: string) => void
  // 가시영역(+언로드 마진) 밖으로 충분히 벗어나 GPU 텍스처를 해제할 아이템.
  onUnload: (id: string) => void
  // 히스테리시스 마진(월드 단위 px). 가시영역을 이만큼 넓힌 범위 밖일 때만 언로드 → 경계 깜빡임 방지.
  // 기본값은 update 시점의 뷰 크기에 비례(아래 resolveMargins)하지만, 절대값으로 고정하고 싶으면 지정.
  margin?: number
}

export interface Virtualizer {
  // 카메라 변경/주기적으로 호출. 가시영역을 다시 계산해 새로 보이는 것은 onLoad, 충분히 벗어난 것은 onUnload.
  update(): void
  // 정리. 추적 상태를 비운다(스프라이트 자체는 호출측 소유라 건드리지 않음).
  destroy(): void
}

// 사각형 a가 b와 교차(겹침)하는지(경계 접촉 포함). 둘 다 월드 좌표.
function intersects(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

// VItem(중심+크기)을 좌상단 기준 Rect로. 회전/플립은 무시(margin이 흡수).
function itemRect(it: VItem): Rect {
  return { x: it.cx - it.w / 2, y: it.cy - it.h / 2, w: it.w, h: it.h }
}

// Rect를 사방으로 m 만큼 확장.
function inflate(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 }
}

// 로드/언로드 마진을 분리해 히스테리시스를 만든다.
//  - loadMargin: 가시영역을 이만큼 넓힌 범위에 "닿으면" 미리 로드(스크롤 진입 직전 선로딩).
//  - unloadMargin: 그보다 더 넓힌 범위 "밖"이어야 언로드 → 두 경계 사이가 데드존이라 경계에서 깜빡이지 않음.
// margin 미지정 시 뷰 크기에 비례(절반)해 화면 한 폭만큼은 항상 살려둔다(팬 한 번에 다 언로드되지 않게).
function resolveMargins(view: Rect, margin: number | undefined): { load: number; unload: number } {
  const base = margin ?? Math.max(view.w, view.h) * 0.5
  // 언로드 경계는 로드 경계보다 한 단계 더 바깥(데드존 폭 = base). 깜빡임 방지의 핵심.
  return { load: base, unload: base * 2 }
}

/**
 * 가상화 컨트롤러를 만든다. update()를 카메라 변경마다(또는 주기적으로) 호출하면,
 * 가시영역 기준으로 onLoad/onUnload를 멱등하게 호출한다.
 *
 * 내부적으로 "현재 로드된 것으로 간주하는 id 집합"을 추적해, 같은 콜백을 중복 발사하지 않는다.
 * 최초 update 전까지는 아무것도 언로드하지 않으므로, 통합 시 첫 프레임에 한 번 update()를 불러
 * 초기 가시 집합을 확정하는 것을 권장한다.
 *
 * @example
 *   const virt = createVirtualizer({
 *     getItems: () => board.items.map(im => ({
 *       id: im.id, cx: im.transform.x, cy: im.transform.y,
 *       w: im.natural.w * im.transform.scale, h: im.natural.h * im.transform.scale,
 *     })),
 *     getViewBounds: () => {
 *       const tl = scene.screenToWorld(0, 0)
 *       const br = scene.screenToWorld(host.clientWidth, host.clientHeight)
 *       return { x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y),
 *                w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }
 *     },
 *     onLoad: (id) => { const s = scene.getSprite(id); if (s) s.visible = true },
 *     onUnload: (id) => { const s = scene.getSprite(id); if (s) { s.visible = false; s.texture.source.unload() } },
 *   })
 *   // applyCam() 끝에서: virt.update()
 */
export function createVirtualizer(opts: VirtualizerOptions): Virtualizer {
  // 현재 "로드됨"으로 간주하는 id 집합. onLoad/onUnload 중복 발사 억제 + 데드존 상태 유지에 사용.
  const loaded = new Set<string>()

  function update(): void {
    const view = opts.getViewBounds()
    // 비정상 뷰(폭/높이 0 이하)면 판정을 건너뛴다(초기화 타이밍·최소화 등). 상태도 그대로 둔다.
    if (!(view.w > 0) || !(view.h > 0)) return
    const { load, unload } = resolveMargins(view, opts.margin)
    const loadArea = inflate(view, load)
    const unloadArea = inflate(view, unload)

    const items = opts.getItems()
    // 이번 프레임에 존재하는 id(삭제된 아이템을 loaded에서 청소하기 위해 수집).
    const present = new Set<string>()

    for (const it of items) {
      present.add(it.id)
      const r = itemRect(it)
      const isLoaded = loaded.has(it.id)
      if (intersects(r, loadArea)) {
        // 로드 영역에 닿음 → 필요. 아직 로드 안 됐으면 onLoad.
        if (!isLoaded) {
          loaded.add(it.id)
          opts.onLoad(it.id)
        }
      } else if (isLoaded && !intersects(r, unloadArea)) {
        // 로드돼 있는데 언로드 영역(더 바깥) 밖으로 완전히 벗어남 → 언로드. (데드존 안이면 그대로 유지)
        loaded.delete(it.id)
        opts.onUnload(it.id)
      }
      // 그 외(로드 영역 밖 ~ 언로드 영역 안 = 데드존): 상태 유지(깜빡임 방지).
    }

    // 사라진(삭제된) 아이템은 추적 집합에서 제거(언로드 콜백은 부르지 않음 — 스프라이트가 이미 없음).
    if (loaded.size > 0) {
      for (const id of [...loaded]) if (!present.has(id)) loaded.delete(id)
    }
  }

  function destroy(): void {
    loaded.clear()
  }

  return { update, destroy }
}

// ──────────────────────────────────────────────────────────────────────────
// 스트레스 테스트 하니스 (개발용) — 대량 이미지 주입 + FPS 측정.
// ──────────────────────────────────────────────────────────────────────────

// spawnStressImages 결과 1건(보드 일괄 주입용). main의 placeImageWithSize(src, size, x, y)에 그대로 흘려보낼 수 있다.
export interface StressImage {
  src: string // 절차적 PNG data URL
  w: number // 원본 픽셀 폭
  h: number // 원본 픽셀 높이
}

// HSL → CSS 색 문자열(절차적 색상환). 더미 이미지마다 색을 다르게 줘 시각적으로 구분되게 한다.
function hslColor(i: number, total: number): string {
  const hue = Math.round((360 * i) / Math.max(1, total))
  return `hsl(${hue}, 65%, 55%)`
}

/**
 * N장(권장 100~500)의 더미 이미지를 절차적 canvas로 생성해 반환한다(개발/스트레스 테스트용).
 * 각 이미지는 고유 색 배경 + 가운데 일련번호 텍스트의 작은 PNG data URL이다.
 * 보드 일괄 주입 예: spawnStressImages(300).forEach((im, i) => placeImageWithSize(im.src, {w:im.w,h:im.h}, gridX(i), gridY(i)))
 *
 * @param count 생성 장수(1 미만이면 빈 배열). 500을 크게 넘기면 data URL 메모리에 주의.
 * @param size  각 더미의 한 변 픽셀(기본 256). 정사각형.
 */
export function spawnStressImages(count: number, size = 256): StressImage[] {
  const out: StressImage[] = []
  if (count < 1) return out
  for (let i = 0; i < count; i++) {
    const cv = document.createElement('canvas')
    cv.width = size
    cv.height = size
    const ctx = cv.getContext('2d')
    if (!ctx) break // 캔버스 2D 미지원 환경(이론상). 가능한 만큼만 반환.
    // 배경(고유 색) + 테두리(번호 가독성).
    ctx.fillStyle = hslColor(i, count)
    ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    ctx.lineWidth = Math.max(2, size * 0.02)
    ctx.strokeRect(0, 0, size, size)
    // 가운데 일련번호(0-기준). 어떤 타일이 화면에 떴는지 눈으로 추적 가능.
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${Math.round(size * 0.28)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i), size / 2, size / 2)
    out.push({ src: cv.toDataURL('image/png'), w: size, h: size })
  }
  return out
}

// measureFps 결과: 측정 구간의 평균 FPS와 카운트한 프레임 수.
export interface FpsResult {
  fps: number // 평균 프레임/초(= frames / 실제경과초)
  frames: number // 측정 구간 동안 카운트한 rAF 콜백 수
}

/**
 * requestAnimationFrame 콜백을 durationMs 동안 세어 평균 FPS를 구한다(간단 측정).
 * 렌더 루프와 독립적으로 브라우저 프레젠테이션 주기를 표본한다 — 무거운 씬일수록 rAF 간격이 벌어져 fps가 떨어진다.
 *
 * 사용 예: 대량 주입 + 팬/줌을 돌리는 동안 const { fps } = await measureFps(2000) 로 체감 성능을 수치화.
 *
 * @param durationMs 측정 시간(ms). 너무 짧으면(예: <500) 표본이 적어 흔들린다. 기본 2000.
 * @returns          { fps, frames }. 실제 경과시간으로 나눠 계산(요청 시간과 미세 차이 보정).
 */
export function measureFps(durationMs = 2000): Promise<FpsResult> {
  return new Promise<FpsResult>((resolve) => {
    let frames = 0
    const t0 = performance.now()
    const tick = () => {
      const now = performance.now()
      frames++
      if (now - t0 >= durationMs) {
        const elapsedSec = (now - t0) / 1000
        resolve({ fps: elapsedSec > 0 ? frames / elapsedSec : 0, frames })
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}
