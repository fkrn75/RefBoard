// 터치/포인터 제스처를 "카메라 델타 콜백"으로 추상화한다.
// PixiJS·scene을 전혀 import하지 않는 순수 Pointer Events 모듈 — 통합 측(viewer)이
// onPan/onPinch/onTap 콜백을 자기 카메라(setCamera/screenToWorld)에 매핑한다.
//
// 설계 메모:
// - Pointer Events(pointerdown/move/up/cancel)로 마우스·터치·펜을 단일 경로로 처리.
// - 활성 포인터를 Map으로 추적: 1개=팬, 2개=핀치(중심점 기준 배율 factor).
// - 좌표는 항상 el 기준 로컬 좌표(clientX - rect.left)로 환산해 콜백에 넘긴다.
// - factor는 "직전 프레임 대비 두 포인터 거리 비율"(증분). 누적 줌은 통합 측 책임.

export interface TouchGestureHandlers {
  // 1손가락 드래그: 직전 move 대비 화면 이동량(px).
  onPan: (dx: number, dy: number) => void
  // 2손가락 핀치: factor(직전 대비 거리 비율, >1 확대) + 두 손가락 중심점(el 로컬 px).
  onPinch: (factor: number, centerX: number, centerY: number) => void
  // 짧은 탭(드래그·핀치 없이 떼면): 탭 위치(el 로컬 px). 라이트박스 토글 등에 사용.
  onTap?: (x: number, y: number) => void
}

// 활성 포인터 1건의 최신 위치(el 로컬 좌표).
interface PointerState {
  x: number
  y: number
}

// 탭으로 인정할 임계값: 이동 거리(px)와 지속 시간(ms). 둘 중 하나라도 초과하면 탭 아님.
const TAP_MAX_MOVE = 10
const TAP_MAX_MS = 300

// el에 터치 제스처를 부착하고, 해제 함수를 반환한다.
export function attachTouchGestures(el: HTMLElement, handlers: TouchGestureHandlers): () => void {
  // pointerId → 최신 위치. 동시 터치를 식별하기 위해 Map으로 관리.
  const pointers = new Map<number, PointerState>()

  // 핀치 상태: 직전 프레임의 두 포인터 거리(배율 계산 기준). null=핀치 중 아님.
  let lastPinchDist: number | null = null

  // 탭 판정용: 단일 포인터가 눌린 순간의 위치/시각 + 누적 이동량.
  let tapStartX = 0
  let tapStartY = 0
  let tapStartTime = 0
  let tapMoved = 0
  // 핀치(2손가락)가 한 번이라도 발생했으면 이 제스처는 탭이 아니다.
  let multiTouched = false

  // clientX/Y → el 로컬 좌표로 환산. 매 이벤트마다 rect를 읽어 스크롤/리사이즈에 안전.
  const toLocal = (e: PointerEvent): PointerState => {
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // 현재 활성 포인터 2개의 (중심점, 거리)를 계산.
  const pinchGeometry = (): { cx: number; cy: number; dist: number } | null => {
    if (pointers.size < 2) return null
    // 먼저 들어온 2개만 사용(3손가락 이상은 무시).
    const it = pointers.values()
    const a = it.next().value as PointerState
    const b = it.next().value as PointerState
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const dist = Math.hypot(a.x - b.x, a.y - b.y)
    return { cx, cy, dist }
  }

  const onPointerDown = (e: PointerEvent): void => {
    // 마우스는 좌클릭(주 버튼)만 팬 시작 대상으로. 터치/펜은 button===0 또는 -1로 들어온다.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const p = toLocal(e)
    pointers.set(e.pointerId, p)
    // 끌어도 같은 요소가 계속 이벤트를 받도록 캡처(요소 밖으로 나가도 추적 유지).
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 일부 환경에서 캡처 실패해도 추적 자체는 Map으로 가능 — 무시.
    }

    if (pointers.size === 1) {
      // 단일 포인터: 탭 후보 시작.
      tapStartX = p.x
      tapStartY = p.y
      tapStartTime = performance.now()
      tapMoved = 0
      multiTouched = false
    } else if (pointers.size === 2) {
      // 두 번째 포인터: 핀치 모드 진입. 기준 거리 세팅.
      multiTouched = true
      const g = pinchGeometry()
      lastPinchDist = g ? g.dist : null
    }
  }

  const onPointerMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId)
    if (!prev) return // 추적 대상 아님(누르지 않은 마우스 이동 등).
    const cur = toLocal(e)

    if (pointers.size >= 2) {
      // 핀치: 먼저 새 위치를 반영한 뒤 두 포인터 거리 비율로 factor 산출.
      pointers.set(e.pointerId, cur)
      const g = pinchGeometry()
      if (g && lastPinchDist != null && lastPinchDist > 0) {
        const factor = g.dist / lastPinchDist
        // 미세 떨림은 무시(factor≈1)해 불필요한 줌 갱신을 줄인다.
        if (factor > 0 && Math.abs(factor - 1) > 1e-3) {
          handlers.onPinch(factor, g.cx, g.cy)
        }
        lastPinchDist = g.dist
      }
      return
    }

    // 단일 포인터: 팬. 직전 위치 대비 델타를 콜백으로.
    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    pointers.set(e.pointerId, cur)
    tapMoved += Math.abs(dx) + Math.abs(dy)
    if (dx !== 0 || dy !== 0) handlers.onPan(dx, dy)
  }

  const endPointer = (e: PointerEvent): void => {
    const existed = pointers.delete(e.pointerId)
    if (!existed) return
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      // 이미 해제됨 — 무시.
    }

    if (pointers.size < 2) {
      // 핀치 종료(또는 애초에 핀치 아님): 기준 거리 리셋.
      lastPinchDist = null
    }

    if (pointers.size === 0) {
      // 마지막 포인터가 떨어진 순간 탭 여부 판정.
      const elapsed = performance.now() - tapStartTime
      if (!multiTouched && tapMoved <= TAP_MAX_MOVE && elapsed <= TAP_MAX_MS) {
        handlers.onTap?.(tapStartX, tapStartY)
      }
    }
  }

  // touch-action:none을 걸어 브라우저 기본 제스처(스크롤/줌)와 충돌을 막는다.
  // (CSS로도 지정 가능하지만, 부착 즉시 동작을 보장하기 위해 인라인으로도 설정.)
  const prevTouchAction = el.style.touchAction
  el.style.touchAction = 'none'

  // pointermove는 빈번하므로 passive:false로 등록해 통합 측이 필요 시 막을 수 있게 한다
  // (여기선 preventDefault를 호출하지 않지만, touch-action:none으로 기본 동작은 이미 차단됨).
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', endPointer)
  el.addEventListener('pointercancel', endPointer)

  // 해제 함수: 리스너 제거 + 상태 초기화 + touch-action 원복.
  return () => {
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', endPointer)
    el.removeEventListener('pointercancel', endPointer)
    el.style.touchAction = prevTouchAction
    pointers.clear()
    lastPinchDist = null
  }
}
