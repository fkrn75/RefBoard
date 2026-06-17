// 적응형 배경 그리드 계산 — 무한 캔버스(world 컨테이너를 이동/스케일)의 배경 격자.
//
// 설계 원칙:
//  - 순수 함수. PixiJS/DOM 등 외부 상태에 의존하지 않고 부작용도 없다. 입력(카메라+뷰포트)만으로
//    "화면에 보이는 그리드 라인의 월드 좌표"를 계산해 돌려준다.
//  - 좌표 규약은 scene.ts / minimap.ts와 동일하다: world.position=(cam.x, cam.y), world.scale=cam.zoom.
//    즉 화면→월드 역변환은  worldX = (screenX - cam.x) / cam.zoom  (Y도 동일).
//  - scene가 world 컨테이너 안에서 라인을 그리므로 여기서는 월드 좌표만 산출하면 충분하다
//    (scene 쪽에서 별도 화면 변환이 필요 없다).

export interface GridLines {
  spacing: number            // 실제 적용된 minor 간격(월드 단위) — 적응형으로 결정됨
  verticals: number[]        // minor 세로선들의 x(월드). major는 제외(중복 방지)
  horizontals: number[]      // minor 가로선들의 y(월드). major는 제외(중복 방지)
  majorVerticals: number[]   // major 세로선 x(월드) — 굵게 그릴 용도
  majorHorizontals: number[] // major 가로선 y(월드)
}

// minor 라인의 "화면상" 간격을 이 범위(px) 안에 유지하도록 spacing을 적응시킨다.
// 너무 촘촘하면(< MIN) spacing을 키우고, 너무 성기면(> MAX) spacing을 줄인다.
const MIN_SCREEN_PX = 8
const MAX_SCREEN_PX = 64

// 라인 개수 폭주 방지용 방어적 상한(한 축당). 적응형 간격이 정상 동작하면 보통 수십 개 수준이지만,
// 비정상 입력(아주 작은 viewport에 거대한 spacing 등)에서도 배열이 터지지 않도록 막는다.
const MAX_LINES_PER_AXIS = 2048

// 1-2-5 계열 적응형 간격 산출.
// baseSpacing을 기준으로 10의 거듭제곱 × {1,2,5} 사다리를 오르내리며,
// 화면상 minor 간격(spacing * zoom)이 [MIN_SCREEN_PX, MAX_SCREEN_PX]에 들도록 맞춘다.
// 예: baseSpacing=32 기준 → 6.4, 16, 32, 64, 160, 320 … (32*{0.2,0.5,1,2,5,10}) 식으로 이산 조정.
function adaptiveSpacing(baseSpacing: number, zoom: number): number {
  // 방어: 비정상 입력은 baseSpacing으로 폴백(0/음수/NaN/Infinity 방지).
  if (!(baseSpacing > 0) || !Number.isFinite(baseSpacing)) baseSpacing = 32
  if (!(zoom > 0) || !Number.isFinite(zoom)) return baseSpacing

  // 목표 화면 간격(px)의 기하 중앙값을 노린다 — 한쪽 경계에 붙지 않고 가운데로 수렴.
  const targetPx = Math.sqrt(MIN_SCREEN_PX * MAX_SCREEN_PX)
  // 이상적인(연속) 월드 간격: 화면에서 targetPx가 되려면 worldSpacing*zoom = targetPx.
  const idealWorld = targetPx / zoom

  // idealWorld를 1-2-5 사다리의 한 칸으로 양자화한다.
  // 사다리 한 칸 = baseSpacing * 10^exp * mantissa(mantissa ∈ {1,2,5}).
  const ratio = idealWorld / baseSpacing
  const exp = Math.floor(Math.log10(ratio)) // 10의 거듭제곱 자리
  const pow = Math.pow(10, exp)
  const norm = ratio / pow // [1,10) 범위로 정규화된 잔여 배수

  // 정규화 잔여를 가장 가까운 1-2-5 단계로 스냅.
  let mantissa: number
  if (norm < 1.5) mantissa = 1
  else if (norm < 3.5) mantissa = 2
  else if (norm < 7.5) mantissa = 5
  else mantissa = 10 // 10은 다음 자리의 1과 동일 — pow에 흡수시켜 연속성 유지

  let spacing = baseSpacing * pow * mantissa

  // 양자화 오차로 경계를 살짝 벗어날 수 있으니, 화면 간격 기준으로 한두 단계 보정한다.
  // (사다리: ×2 → ×2.5 → ×2 = ×10 한 바퀴. 아래에서는 그 역순.)
  const ladderUp = [2, 2.5, 2] // 1→2→5→10
  const ladderDown = [2, 2.5, 2] // 10→5→2→1 (나눗셈에 사용)
  let guard = 0
  let upIdx = 0
  let downIdx = 0
  // 너무 촘촘하면 spacing을 키운다(화면 간격 ↑).
  while (spacing * zoom < MIN_SCREEN_PX && guard < 64) {
    spacing *= ladderUp[upIdx % ladderUp.length]
    upIdx++
    guard++
  }
  // 너무 성기면 spacing을 줄인다(화면 간격 ↓).
  while (spacing * zoom > MAX_SCREEN_PX && guard < 64) {
    spacing /= ladderDown[downIdx % ladderDown.length]
    downIdx++
    guard++
  }
  return spacing
}

// spacing 배수 격자선 중 [lo, hi] 구간(여유 1칸 포함)에 걸치는 월드 좌표 라인 인덱스를 산출.
// 반환: 각 라인의 (월드 좌표, 라인 인덱스). 인덱스는 0을 원점으로 한 정수(=좌표/spacing).
function axisLines(
  lo: number,
  hi: number,
  spacing: number,
): { coord: number; index: number }[] {
  const out: { coord: number; index: number }[] = []
  // 보이는 구간을 덮는 첫/끝 인덱스(여유 1칸씩 확장 — 팬 중 경계에서 라인이 끊겨 보이지 않게).
  const startIdx = Math.floor(lo / spacing) - 1
  const endIdx = Math.ceil(hi / spacing) + 1
  // 방어적 상한: 개수가 폭주하면 중앙을 기준으로 잘라낸다(빈 화면보다 일부라도 그리는 편이 안전).
  let count = endIdx - startIdx + 1
  let from = startIdx
  let to = endIdx
  if (count > MAX_LINES_PER_AXIS) {
    const mid = Math.round((startIdx + endIdx) / 2)
    const half = Math.floor(MAX_LINES_PER_AXIS / 2)
    from = mid - half
    to = mid + half
    count = to - from + 1
  }
  for (let i = from; i <= to; i++) {
    out.push({ coord: i * spacing, index: i })
  }
  return out
}

// 카메라 + 뷰포트로부터 화면에 보이는 그리드 라인(월드 좌표)을 계산한다.
//  - cam: 현재 카메라(scene.camera와 동일 형태). x,y는 world 컨테이너 위치, zoom은 스케일.
//  - viewport: 캔버스의 픽셀 크기(w,h).
//  - baseSpacing: 기준 minor 간격(월드 단위, 기본 32). 적응형 간격의 사다리 기준점.
//  - majorEvery: major 라인 주기(기본 5). 라인 인덱스가 이 값의 배수면 major로 분류.
export function visibleGrid(
  cam: { x: number; y: number; zoom: number },
  viewport: { w: number; h: number },
  baseSpacing = 32,
  majorEvery = 5,
): GridLines {
  const zoom = cam.zoom > 0 && Number.isFinite(cam.zoom) ? cam.zoom : 1 // 0/비정상 보호
  const spacing = adaptiveSpacing(baseSpacing, zoom)

  // major 주기 방어(0/음수/비정수 → 비활성 취급: 모두 minor).
  const every =
    Number.isFinite(majorEvery) && majorEvery >= 1 ? Math.floor(majorEvery) : 0

  // 화면 (0,0)~(w,h) 네 모서리를 월드로 역변환 → 보이는 월드 사각형.
  // worldX = (screenX - cam.x) / zoom (Y 동일). 좌표계가 뒤집힐 일은 없지만 min/max로 정규화.
  const wx0 = (0 - cam.x) / zoom
  const wx1 = (viewport.w - cam.x) / zoom
  const wy0 = (0 - cam.y) / zoom
  const wy1 = (viewport.h - cam.y) / zoom
  const minX = Math.min(wx0, wx1)
  const maxX = Math.max(wx0, wx1)
  const minY = Math.min(wy0, wy1)
  const maxY = Math.max(wy0, wy1)

  const vert = axisLines(minX, maxX, spacing)
  const horiz = axisLines(minY, maxY, spacing)

  const verticals: number[] = []
  const majorVerticals: number[] = []
  for (const { coord, index } of vert) {
    // 라인 인덱스가 major 주기의 배수면 major, 아니면 minor(중복 방지 위해 한쪽에만 넣는다).
    if (every > 0 && index % every === 0) majorVerticals.push(coord)
    else verticals.push(coord)
  }

  const horizontals: number[] = []
  const majorHorizontals: number[] = []
  for (const { coord, index } of horiz) {
    if (every > 0 && index % every === 0) majorHorizontals.push(coord)
    else horizontals.push(coord)
  }

  return { spacing, verticals, horizontals, majorVerticals, majorHorizontals }
}
