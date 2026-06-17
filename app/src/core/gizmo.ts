// 변형 기즈모 기하 + 드래그 변환 수학 — 순수·무상태 모듈.
// 렌더(PixiJS)·포인터 이벤트는 team-lead가 scene/main에서 담당하고,
// 이 모듈은 오직 "월드 좌표 계산"과 "새 부분 transform 산출"만 책임진다.
//
// 좌표 규약(전 함수 공통):
//  - 로컬 좌표계: 아이템 중심이 원점. 박스 반폭 hw = natural.w*scale/2,
//    반높이 hh = natural.h*scale/2 (회전 전, +x=오른쪽 / +y=아래쪽 화면 좌표계 가정).
//  - 월드 변환: 로컬점을 rotation(라디안)으로 회전한 뒤 중심 (t.x, t.y)로 평행이동.
//  - flip(부호 반전)은 의도적으로 무시한다(team-lead가 렌더 단계에서 처리).

import type { Transform } from './board'

// 기즈모 핸들 식별자 — 8개 변형 핸들(모서리4+변중점4) + 회전 핸들.
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

// 월드 좌표로 환산된 핸들 1개.
export interface GizmoHandle {
  id: HandleId
  x: number // 월드 x
  y: number // 월드 y
}

// 8개 변형 핸들의 "로컬 단위 방향"(중심 기준, 반폭/반높이의 부호 계수).
// 예: 'nw' = 좌상단 = (-1,-1), 'n' = 상단 변 중점 = (0,-1).
// 이 표는 핸들 위치 산출과 "반대편 피벗" 산출(부호 반전)에 함께 쓰인다.
const HANDLE_DIRS: Record<Exclude<HandleId, 'rotate'>, { sx: number; sy: number }> = {
  nw: { sx: -1, sy: -1 },
  n: { sx: 0, sy: -1 },
  ne: { sx: 1, sy: -1 },
  e: { sx: 1, sy: 0 },
  se: { sx: 1, sy: 1 },
  s: { sx: 0, sy: 1 },
  sw: { sx: -1, sy: 1 },
  w: { sx: -1, sy: 0 },
}

// 로컬 오프셋(ox, oy)을 rotation으로 회전한 뒤 중심(cx, cy)에 더해 월드 좌표로 변환.
//  [수학] 표준 2D 회전행렬:
//    wx = cx + ox*cos − oy*sin
//    wy = cy + ox*sin + oy*cos
function localToWorld(
  ox: number,
  oy: number,
  rotation: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return {
    x: cx + ox * cos - oy * sin,
    y: cy + ox * sin + oy * cos,
  }
}

// 핸들 전체의 월드 좌표를 산출.
//  - 8개 변형 핸들: 반폭 hw, 반높이 hh에 방향 계수를 곱해 로컬 오프셋을 만든 뒤 월드로 변환.
//  - rotate 핸들: 상단 변 중점('n')에서 박스 바깥(위쪽)으로 rotateOffset(월드 단위)만큼 더 띄운다.
//    로컬에서 위쪽은 −y 이므로 oy = −(hh + rotateOffset).
export function handlePositions(
  t: Transform,
  natural: { w: number; h: number },
  rotateOffset = 30,
): GizmoHandle[] {
  const hw = (natural.w * t.scale) / 2 // 반폭(월드)
  const hh = (natural.h * t.scale) / 2 // 반높이(월드)

  const out: GizmoHandle[] = []

  // 8개 변형 핸들 — 표(HANDLE_DIRS) 순회.
  for (const id of Object.keys(HANDLE_DIRS) as Exclude<HandleId, 'rotate'>[]) {
    const dir = HANDLE_DIRS[id]
    const p = localToWorld(dir.sx * hw, dir.sy * hh, t.rotation, t.x, t.y)
    out.push({ id, x: p.x, y: p.y })
  }

  // 회전 핸들 — 상단 변 중점에서 rotateOffset만큼 더 바깥(위)으로.
  const rp = localToWorld(0, -(hh + rotateOffset), t.rotation, t.x, t.y)
  out.push({ id: 'rotate', x: rp.x, y: rp.y })

  return out
}

// 포인터 월드 좌표에 가장 가까운 핸들을 반환. 허용 반경(tolWorld, 월드 단위) 밖이면 null.
//  [수학] 제곱거리로 비교(√ 생략) — 최소값만 찾으면 되므로 비용 절약. 임계 비교만 tol²로.
export function hitTest(
  world: { x: number; y: number },
  handles: GizmoHandle[],
  tolWorld: number,
): HandleId | null {
  let best: HandleId | null = null
  let bestD2 = tolWorld * tolWorld // 허용 반경의 제곱(이보다 멀면 후보 제외)

  for (const h of handles) {
    const dx = h.x - world.x
    const dy = h.y - world.y
    const d2 = dx * dx + dy * dy
    if (d2 <= bestD2) {
      bestD2 = d2
      best = h.id
    }
  }
  return best
}

// 두 점이 이루는 벡터의 길이(월드).
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return Math.hypot(dx, dy)
}

// 모서리/변 핸들 드래그로 균등 scale을 변경하고, 피벗 고정에 따른 새 중심(x, y)을 산출.
//
// 피벗 규약:
//  - 기본(centered=false): 드래그하는 핸들의 "반대편"이 고정점(피벗).
//    'se'를 끌면 'nw'가 고정, 'n'을 끌면 's'가 고정. 중심은 피벗을 기준으로 새 scale에 맞춰 재배치된다.
//  - centered=true(Alt): 중심(t.x, t.y) 고정 → 중심 이동 없음(x, y 불변), 양쪽이 대칭으로 늘고 준다.
//
//  [수학]
//   1) 피벗의 로컬 방향 = 핸들 방향의 부호 반전. 피벗 로컬 오프셋 = (−sx*hw, −sy*hh).
//      이를 회전·평행이동해 피벗 월드좌표 P를 구한다(현재 scale 기준).
//   2) 거리비 ratio = |curWorld − P| / |startWorld − P|.
//      (피벗에서 본 포인터의 반경 변화 = 균등 스케일 배율)
//   3) newScale = t.scale * ratio  (최소값 가드 적용).
//   4) centered=false면 피벗을 고정한 채 중심을 역산:
//        피벗의 "로컬 단위 방향"(부호만, 스케일 무관)은 scale이 변해도 그대로다.
//        새 반폭/반높이 hw'/hh'로 피벗 로컬 오프셋을 다시 만들어 회전하면, 중심→피벗 월드 벡터 v' 가 나온다.
//        피벗 위치 P는 고정이므로 newCenter = P − v'.
//      centered=true면 newCenter = (t.x, t.y).
export function scaleFromHandle(
  handle: HandleId,
  t: Transform,
  natural: { w: number; h: number },
  startWorld: { x: number; y: number },
  curWorld: { x: number; y: number },
  opts: { centered: boolean },
): { scale: number; x: number; y: number } {
  // 회전 핸들은 스케일 대상이 아니다 — 방어적으로 현재 값 그대로 반환.
  if (handle === 'rotate') {
    return { scale: t.scale, x: t.x, y: t.y }
  }

  const dir = HANDLE_DIRS[handle]
  const hw = (natural.w * t.scale) / 2 // 현재 반폭
  const hh = (natural.h * t.scale) / 2 // 현재 반높이

  // 1) 피벗(반대편) 월드좌표 P — 핸들 방향의 부호를 뒤집은 로컬 오프셋.
  //    centered=true면 피벗은 중심 자신.
  const pivot = opts.centered
    ? { x: t.x, y: t.y }
    : localToWorld(-dir.sx * hw, -dir.sy * hh, t.rotation, t.x, t.y)

  // 2) 거리비 — 피벗에서 잰 start/cur 반경의 비.
  const startR = dist(startWorld.x, startWorld.y, pivot.x, pivot.y)
  const curR = dist(curWorld.x, curWorld.y, pivot.x, pivot.y)

  // start 반경이 0에 수렴하면(피벗과 시작점이 겹침) 비가 정의되지 않음 → 변경 없이 안전 반환.
  if (startR < 1e-6) {
    return { scale: t.scale, x: t.x, y: t.y }
  }

  const ratio = curR / startR

  // 3) 새 scale — 최소 가드(>0.01)로 0/음수/반전 방지.
  const newScale = Math.max(0.01, t.scale * ratio)

  // centered면 중심 고정.
  if (opts.centered) {
    return { scale: newScale, x: t.x, y: t.y }
  }

  // 4) 피벗을 고정한 채 중심 역산.
  //    새 반폭/반높이로 피벗의 로컬 오프셋을 다시 만들고 회전 → 중심→피벗 벡터 v'.
  const hw2 = (natural.w * newScale) / 2
  const hh2 = (natural.h * newScale) / 2
  const cos = Math.cos(t.rotation)
  const sin = Math.sin(t.rotation)
  // 피벗 로컬 오프셋(부호는 그대로, 크기만 새 scale 반영).
  const pox = -dir.sx * hw2
  const poy = -dir.sy * hh2
  // v' = R(rotation) · (pox, poy)  — 중심에서 피벗까지의 월드 벡터.
  const vx = pox * cos - poy * sin
  const vy = pox * sin + poy * cos
  // 피벗 P 고정 → 중심 = P − v'.
  return { scale: newScale, x: pivot.x - vx, y: pivot.y - vy }
}

// 회전 핸들(또는 자유 회전) 드래그로 rotation을 갱신.
//  [수학] 중심(t.x, t.y) 기준으로 start/cur 포인터의 편각을 atan2로 구하고,
//   그 각도차(delta)를 기존 rotation에 가산한다.
//   atan2(dy, dx)는 −π..π 범위지만, 차이를 더하는 방식이라 경계 wrap을 따로 처리할 필요는 없다
//   (연속 드래그에서 프레임당 delta가 작으므로 누적도 자연스럽다).
//  snap45=true(Shift): 결과를 45°(π/4) 격자에 스냅.
export function rotateFromPointer(
  t: Transform,
  startWorld: { x: number; y: number },
  curWorld: { x: number; y: number },
  snap45: boolean,
): { rotation: number } {
  // 중심 기준 두 포인터의 편각.
  const a0 = Math.atan2(startWorld.y - t.y, startWorld.x - t.x)
  const a1 = Math.atan2(curWorld.y - t.y, curWorld.x - t.x)
  const delta = a1 - a0 // 회전 증분(라디안)

  let r = t.rotation + delta

  // 45° 스냅 — 가장 가까운 π/4 배수로 반올림.
  if (snap45) {
    const step = Math.PI / 4
    r = Math.round(r / step) * step
  }

  return { rotation: r }
}
