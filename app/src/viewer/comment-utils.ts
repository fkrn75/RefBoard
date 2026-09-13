// 이미지 댓글(comment) 판정 + 화면 배지 배치 — 순수 함수만 모아 DOM/PixiJS 없이 단위 테스트 가능하게 분리.
//
// 배경: 댓글은 보드 데이터(BoardImage.comment)에만 존재하고 캔버스(PixiJS)는 텍스트를 그리지 않는다.
// 데스크탑은 마우스 호버 툴팁(main.ts)으로 노출하지만, 터치 기기는 호버 개념이 없어 댓글이 아예
// "발견 불가능"했다(감사 지적). 이 파일은 그 발견 가능성을 위한 두 가지를 순수 함수로 제공한다:
//  1) hasComment — 댓글 유무 판정(공백만 있는 문자열은 댓글 없음으로 취급, main.ts 기존 규칙과 동일)
//  2) buildCommentBadgeAnchors — 댓글 있는 이미지마다 배지를 띄울 월드 좌표 앵커 목록 산출
// 화면 좌표 변환(worldToScreen)·DOM 배지 생성/리포지셔닝은 카메라 상태를 쥔 main.ts가 담당한다.

import { isImageItem, type BoardImage, type BoardItem } from '../core/board'

// 댓글이 실제로 "표시할 내용"을 갖고 있는지(공백뿐인 문자열은 댓글 없음).
// main.ts의 commentAt()·배지·라이트박스·a11y 목록이 모두 이 판정을 공유해 기준이 어긋나지 않게 한다.
export function hasComment(it: BoardItem): it is BoardImage {
  return isImageItem(it) && !!it.comment && it.comment.trim().length > 0
}

// 배지 1개가 필요로 하는 최소 정보(월드 좌표 앵커 + 표시용 댓글 텍스트).
export interface CommentBadgeAnchor {
  id: string
  comment: string
  worldX: number // 배지를 둘 월드 좌표(아이템 AABB 우상단 코너)
  worldY: number
}

// 댓글이 있는 이미지들의 배지 앵커 목록을 계산한다.
//  - getAABB: 아이템 id → 월드 AABB(없으면 null, 예: 렌더 전/삭제된 아이템). scene.getItemAABB를 주입.
//  - AABB가 없는 아이템(예외적 상황)은 조용히 건너뛴다 — 배지 목록에서 빠질 뿐 렌더 자체는 안전.
export function buildCommentBadgeAnchors(
  items: BoardItem[],
  getAABB: (id: string) => { minX: number; minY: number; maxX: number; maxY: number } | null,
): CommentBadgeAnchor[] {
  const out: CommentBadgeAnchor[] = []
  for (const it of items) {
    if (!hasComment(it)) continue
    const a = getAABB(it.id)
    if (!a) continue
    // 우상단 코너에 살짝 바깥으로 — 이미지 내용을 가리지 않으면서 시선이 먼저 닿는 위치.
    // hasComment가 이미 "공백 아닌 문자열"을 보장하지만, comment 필드 자체는 optional이라
    // 타입상으로는 string|undefined다 — ?? ''는 실행에 영향 없는 타입 정합용 폴백.
    out.push({ id: it.id, comment: it.comment ?? '', worldX: a.maxX, worldY: a.minY })
  }
  return out
}

// 접근성 sr-only 이미지 목록(buildA11yImageList)의 버튼 라벨에 댓글 유무를 덧붙인다.
// 스크린리더 사용자도 "댓글이 달려 있다"는 사실과 내용을 목록만으로 알 수 있어야 한다(터치와 동일한
// 발견 가능성 결함이 비시각 사용자에게도 있었다).
export function buildA11yImageLabel(index: number, total: number, comment: string | null): string {
  const base = `이미지 ${index + 1} 크게 보기 (총 ${total}개)`
  return comment ? `${base} · 댓글: ${comment}` : base
}
