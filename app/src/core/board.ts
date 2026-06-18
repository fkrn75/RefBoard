// 보드 상태 모델 — 데스크탑·웹뷰어가 공유하는 직렬화 가능한 단일 진실 공급원(SSOT).
// 이 JSON을 그대로 .refb 저장과 (나중에) 웹 공유에 사용한다.

export interface Transform {
  x: number        // 캔버스(월드) 좌표계의 중심 위치
  y: number
  scale: number    // 균등 스케일 배율
  rotation: number // 회전(라디안)
  flipX?: boolean  // 좌우 뒤집기 (렌더 시 scale.x 부호 반전, 비파괴)
  flipY?: boolean  // 상하 뒤집기 (렌더 시 scale.y 부호 반전, 비파괴)
}

// 비파괴 크롭: 원본 픽셀 기준 사각형(없으면 원본 전체). transform과 독립 — 크롭 리셋 ≠ 변형 리셋.
export interface Crop {
  x: number // 원본 픽셀 좌상단 x
  y: number // 원본 픽셀 좌상단 y
  w: number // 크롭 폭(원본 픽셀)
  h: number // 크롭 높이(원본 픽셀)
}

export interface BoardImage {
  id: string
  type: 'image'
  src: string                  // 임베드(data URL) 또는 링크(파일/웹 경로)
  natural: { w: number; h: number } // 원본 픽셀 크기
  transform: Transform
  crop?: Crop                  // 선택적 비파괴 크롭(없으면 원본 전체)
  opacity: number
  locked: boolean
  groupId?: string             // 그룹 식별자(같은 값=한 그룹, 없으면 미그룹) — Phase 2.6 그룹
  z: number                    // 캔버스 내 레이어 순서
}

// 추후 note / group / drawing 아이템 타입을 유니온으로 추가
export type BoardItem = BoardImage

export interface BoardState {
  schema: 'refboard/1.0'
  board: {
    id: string
    title: string
    canvas: { bg: string }
  }
  camera: { x: number; y: number; zoom: number }
  items: BoardItem[]
}

// 빈 보드 생성
export function createEmptyBoard(): BoardState {
  return {
    schema: 'refboard/1.0',
    board: { id: genId(), title: '제목 없음', canvas: { bg: '#1e1e1e' } },
    camera: { x: 0, y: 0, zoom: 1 },
    items: [],
  }
}

// 직렬화 / 역직렬화 (.refb · 웹 공유 공통 경로)
export function serialize(state: BoardState): string {
  return JSON.stringify(state)
}
export function deserialize(json: string): BoardState {
  return JSON.parse(json) as BoardState
}

// 짧은 고유 ID 생성 (crypto 우선, 미지원 환경은 폴백)
export function genId(): string {
  const c = globalThis.crypto
  // 12자리 사용 — assets/<id> 자산 경로·공유 id의 충돌 위험 완화(8자리는 엔트로피 부족, bug-io P2).
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '').slice(0, 12)
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}
