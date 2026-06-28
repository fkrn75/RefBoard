// 렌더링 설정 — 픽셀 보간(확대 시 도트/부드럽게) 등 캔버스 렌더 옵션을 localStorage에 영속한다.
// theme.ts/keymap.ts와 동일한 "공개 API + 변경 구독" 패턴. settings-panel(일반 탭)은 이 API만 사용한다.
//  - pixelated=false(기본): 확대 시 부드럽게(linear 보간)
//  - pixelated=true: 확대 시 도트 유지(nearest) — 픽셀아트 레퍼런스용

const STORAGE_KEY = 'rb.render'

export interface RenderSettings {
  pixelated: boolean
}

const DEFAULT: RenderSettings = { pixelated: false }

let current: RenderSettings = load()
const subscribers = new Set<(s: RenderSettings) => void>()

// localStorage에서 로드(없거나 파싱 실패 시 기본값). 알 수 없는 필드는 무시한다.
function load(): RenderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT }
    const parsed = JSON.parse(raw) as Partial<RenderSettings>
    return { ...DEFAULT, pixelated: parsed.pixelated === true }
  } catch {
    return { ...DEFAULT }
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // 저장 실패(프라이빗 모드·할당량 초과 등)는 무시 — 세션 내 동작은 그대로 유지한다.
  }
}

// 현재 렌더 설정(읽기 전용 의미로 사용).
export function getRenderSettings(): RenderSettings {
  return current
}

// 픽셀 보간 토글. 값이 바뀌면 저장하고 구독자에게 통지한다.
export function setPixelated(on: boolean): void {
  if (current.pixelated === on) return
  current = { ...current, pixelated: on }
  save()
  for (const fn of subscribers) fn(current)
}

// 렌더 설정 변경 구독. 반환 함수를 호출하면 해제된다.
export function onRenderSettingsChange(fn: (s: RenderSettings) => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}
