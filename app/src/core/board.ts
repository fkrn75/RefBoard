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

// 다중 해상도 이미지 세트(웹 공유 대역폭·초기 로딩 최적화 — Phase 5.1/5.3).
// 공유 export 시점에만 생성한다(편집 보드는 단일 src 유지로 용량 증가 방지).
// 뷰어는 srcs가 있으면 medium(보드뷰)/orig(라이트박스)를 고르고, 없으면 src로 폴백(하위호환).
export interface ImageSrcSet {
  thumb: string  // 긴 변 ~256px (저대역·초기 로드)
  medium: string // 긴 변 ~1024px (보드 뷰 기본)
  orig: string   // 원본(또는 4096 상한) — 라이트박스 풀스크린
}

export interface BoardImage {
  id: string
  type: 'image'
  src: string                  // 임베드(data URL) 또는 링크(파일/웹 경로)
  srcs?: ImageSrcSet           // 다중 해상도(공유 export 시 생성, 없으면 src 폴백) — Phase 5.1/5.3
  natural: { w: number; h: number } // 원본 픽셀 크기
  transform: Transform
  crop?: Crop                  // 선택적 비파괴 크롭(없으면 원본 전체)
  opacity: number
  locked: boolean
  groupId?: string             // 그룹 식별자(같은 값=한 그룹, 없으면 미그룹) — Phase 2.6 그룹
  z: number                    // 캔버스 내 레이어 순서
  comment?: string             // 이미지에 부착하는 메모(코멘트) — Alt+C로 편집, 없으면 미부착
  name?: string                // 원본 파일명(정렬/표시용). 없으면 id로 폴백 — 선택 필드(하위호환)
  addedAt?: number             // 보드에 추가된 시각(Date.now() epoch ms). 없으면 z로 폴백 — 선택 필드(하위호환)
}

// 텍스트 노트 — 보드 위 글자 박스(1차는 평문, 리치텍스트는 추후).
// 이미지와 동일하게 중심(anchor 0.5) 기준 transform·natural(고유 픽셀 크기)·z를 공유하므로
// 선택/이동/리사이즈/회전 기즈모에 그대로 편입된다(scene·gizmo 무특화).
export interface BoardNote {
  id: string
  type: 'note'
  text: string                       // 표시 문자열(평문)
  fontSize: number                   // 기준 폰트 크기(px, scale=1 기준). 확대는 transform.scale로
  fontFamily?: string                // 글꼴(CSS font-family). 없으면 기본(Pretendard/맑은 고딕) — 하위호환
  color: string                      // 글자색(#rrggbb)
  natural: { w: number; h: number }  // 렌더된 텍스트 박스 크기(측정값). AABB·기즈모 산출 기준
  transform: Transform
  opacity: number
  locked: boolean
  groupId?: string
  z: number
}

// 펜 자유선 / 도형 도구. 지우개는 입력 모드(별도 아이템 아님)라 여기 미포함.
export type DrawingTool = 'pen' | 'line' | 'rect' | 'ellipse' | 'arrow'

// 드로잉 아이템 — points는 "고유 박스 중심(0,0)" 기준 로컬 좌표.
// pen=연속점, line/arrow=시작·끝 2점, rect/ellipse=대각 2점.
// 월드 배치/크기/회전은 transform이 담당(이미지·노트와 동일 모델 → 기즈모 자동 편입).
export interface BoardDrawing {
  id: string
  type: 'drawing'
  tool: DrawingTool
  points: { x: number; y: number }[]
  color: string                      // 선 색(#rrggbb)
  width: number                      // 선 굵기(px, scale=1 기준)
  natural: { w: number; h: number }  // 바운딩 박스 크기. AABB·기즈모 산출 기준
  transform: Transform
  opacity: number
  locked: boolean
  groupId?: string
  z: number
}

// 보드 아이템 유니온(추후 group 등 추가 가능)
export type BoardItem = BoardImage | BoardNote | BoardDrawing

// 타입 가드 — 직렬화(.refb 자산화)·공유 업로드의 "이미지 전용" 분기에서 사용.
export const isImageItem = (it: BoardItem): it is BoardImage => it.type === 'image'
export const isNoteItem = (it: BoardItem): it is BoardNote => it.type === 'note'
export const isDrawingItem = (it: BoardItem): it is BoardDrawing => it.type === 'drawing'

export interface BoardState {
  schema: 'refboard/1.0'
  board: {
    id: string
    title: string
    canvas: { bg: string }
    // 마지막으로 클라우드 공유한 board_id. 있으면 재공유 시 새 보드를 만들지 않고 이 링크를 갱신한다
    // (중복 누적 방지). serialize(JSON.stringify)로 .refb·자동저장에 함께 영속된다.
    shareId?: string
    // 마지막 공유 시 공개 여부(상태바 배지 표시용). shareId와 함께 영속된다.
    sharePublic?: boolean
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
