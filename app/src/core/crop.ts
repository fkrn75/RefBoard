// 비파괴 크롭 기하 계산 — 순수·무상태 모듈.
// 모든 좌표/크기는 "원본 픽셀" 기준(natural)으로 다룬다. transform·카메라와 무관.
// 마스크 렌더·크롭모드 UI 배선은 scene/main(team-lead)에서 담당하고, 여기는 수치만 책임진다.

import type { Crop } from './board'

// 크롭 폭/높이의 최소값(px). 0·음수 크기로 인한 텍스처 frame 오류·NaN 전파를 막는다.
const MIN_SIZE = 1

// 값을 [min, max] 구간으로 가두는 헬퍼. NaN은 min으로 떨어뜨려 방어한다.
function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min
  if (v < min) return min
  if (v > max) return max
  return v
}

// 원본 폭/높이를 안전한 정수 양수로 정규화(최소 1px). natural이 깨진 경우의 1차 방어.
function safeNatural(natural: { w: number; h: number }): { w: number; h: number } {
  const w = Math.max(MIN_SIZE, Math.floor(natural.w))
  const h = Math.max(MIN_SIZE, Math.floor(natural.h))
  return { w, h }
}

// 원본 전체를 덮는 기본 크롭. 크롭 적용 시작점으로 사용.
export function defaultCrop(natural: { w: number; h: number }): Crop {
  const n = safeNatural(natural)
  return { x: 0, y: 0, w: n.w, h: n.h }
}

// 크롭 사각형을 원본 경계 [0..w, 0..h] 안으로 클램프.
// 좌상단을 먼저 범위 안으로 넣고, 남은 공간에 맞춰 폭/높이를 최소 1px 보장하며 잘라낸다.
export function clampCrop(crop: Crop, natural: { w: number; h: number }): Crop {
  const n = safeNatural(natural)

  // 좌상단: 원본 안에서 최소 1px 들어갈 자리를 남기도록 (n - MIN_SIZE)까지만 허용.
  const x = clamp(Math.round(crop.x), 0, n.w - MIN_SIZE)
  const y = clamp(Math.round(crop.y), 0, n.h - MIN_SIZE)

  // 폭/높이: 음수·0 방지(최소 1px), 우/하 경계를 넘지 않도록 남은 공간으로 상한.
  const w = clamp(Math.round(crop.w), MIN_SIZE, n.w - x)
  const h = clamp(Math.round(crop.h), MIN_SIZE, n.h - y)

  return { x, y, w, h }
}

// 크롭이 원본 전체와 같은지 여부. 없거나(undefined) 전체 영역이면 true.
// 전체면 마스크·frame 분기를 생략(렌더 비용 절감)할 수 있다.
export function isFullCrop(crop: Crop | undefined, natural: { w: number; h: number }): boolean {
  if (!crop) return true
  const n = safeNatural(natural)
  const c = clampCrop(crop, n)
  return c.x === 0 && c.y === 0 && c.w === n.w && c.h === n.h
}

// 실제 표시될 픽셀 크기. 크롭이 없으면 원본(natural), 있으면 클램프된 크롭의 w/h.
export function croppedSize(
  crop: Crop | undefined,
  natural: { w: number; h: number },
): { w: number; h: number } {
  const n = safeNatural(natural)
  if (!crop) return n
  const c = clampCrop(crop, n)
  return { w: c.w, h: c.h }
}

// 크롭모드 드래그: 두 점(원본 픽셀 좌표)으로 사각형을 만든다.
// 어느 방향으로 끌든(역드래그 포함) min/max로 정규화한 뒤 clamp로 경계 방어.
export function cropRectFromDrag(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  natural: { w: number; h: number },
): Crop {
  const x = Math.min(p0.x, p1.x)
  const y = Math.min(p0.y, p1.y)
  const w = Math.abs(p1.x - p0.x)
  const h = Math.abs(p1.y - p0.y)
  return clampCrop({ x, y, w, h }, natural)
}

// PixiJS 텍스처 frame 매핑용. Texture.frame(new Rectangle(x,y,w,h))에 넣을 원본픽셀 사각형.
// 크롭이 없으면 원본 전체를 돌려준다. 반환 타입은 Pixi Rectangle 인자와 동일한 평범한 형태.
export function cropToFrame(
  crop: Crop | undefined,
  natural: { w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (!crop) return defaultCrop(natural)
  return clampCrop(crop, natural)
}
