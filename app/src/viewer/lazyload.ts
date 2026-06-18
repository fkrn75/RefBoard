// 뷰포트 기반 이미지 lazy-load / unload.
// IntersectionObserver로 "관찰 중인 요소가 화면(root)에 들어오면 onEnter, 벗어나면 onExit"을
// id 단위로 통지한다. 통합 측(viewer)은 onEnter에서 텍스처 로드, onExit에서 메모리 해제 등을
// 자유롭게 구현한다(이 모듈은 로딩 자체엔 관여하지 않는다 — 가시성 신호만 제공).
//
// 모바일에서 보드에 수백 장이 있어도 화면 근처만 디코드/유지해 GPU 메모리를 아낀다.

export interface LazyLoaderOptions {
  // 교차 판정 기준 컨테이너. 생략 시 브라우저 뷰포트(null).
  root?: HTMLElement
  // 요소가 화면에 들어옴 — 해당 id 이미지 로드.
  onEnter: (id: string) => void
  // 요소가 화면을 벗어남 — 해당 id 이미지 언로드(선택적).
  onExit: (id: string) => void
  // 미리 로드/유지할 여유 영역(CSS margin 문법). 기본 200px(스크롤 직전 선로딩).
  rootMargin?: string
}

export interface LazyLoader {
  // 요소를 관찰 시작하고 id를 연결.
  observe(el: HTMLElement, id: string): void
  // 특정 요소 관찰 중단(요소 제거 시).
  unobserve(el: HTMLElement): void
  // 전체 관찰 해제 + 내부 상태 정리.
  disconnect(): void
}

export function createLazyLoader(opts: LazyLoaderOptions): LazyLoader {
  // 관찰 중인 element → id 매핑. IntersectionObserverEntry.target으로 id를 역참조한다.
  const elementIds = new WeakMap<Element, string>()
  // 현재 교차 상태를 기억해 중복 통지(같은 상태 재발화)를 막는다.
  const visible = new WeakMap<Element, boolean>()

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = elementIds.get(entry.target)
        if (id == null) continue
        const nowVisible = entry.isIntersecting
        const wasVisible = visible.get(entry.target) ?? false
        if (nowVisible === wasVisible) continue // 상태 변화 없음 — 통지 생략.
        visible.set(entry.target, nowVisible)
        if (nowVisible) opts.onEnter(id)
        else opts.onExit(id)
      }
    },
    {
      // root는 Element | Document | null. HTMLElement는 Element이므로 그대로 사용.
      root: opts.root ?? null,
      rootMargin: opts.rootMargin ?? '200px',
      threshold: 0,
    },
  )

  return {
    observe(el: HTMLElement, id: string): void {
      elementIds.set(el, id)
      visible.set(el, false)
      observer.observe(el)
    },
    unobserve(el: HTMLElement): void {
      observer.unobserve(el)
      elementIds.delete(el)
      visible.delete(el)
    },
    disconnect(): void {
      observer.disconnect()
      // WeakMap은 GC에 맡긴다(명시적 clear 불가).
    },
  }
}
