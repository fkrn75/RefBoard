// PWA 지원: 서비스워커 등록 + 설치 프롬프트(beforeinstallprompt) 헬퍼.
// 모바일 뷰어를 홈 화면에 설치하고 오프라인 캐시를 동작시키기 위한 진입점.

// beforeinstallprompt 이벤트는 아직 표준 lib.dom에 없어 최소 형태로 직접 선언한다.
// (Chromium 계열에서만 발생 — 사용 전 존재 여부를 확인하므로 미지원 브라우저는 안전.)
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

// 서비스워커를 등록한다. 미지원 환경(구형 브라우저/비 HTTPS)에서는 조용히 패스.
// swUrl 기본값은 '/sw.js'(public 루트에 배치 → 사이트 전체를 스코프로).
export async function registerServiceWorker(swUrl: string = '/sw.js'): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register(swUrl, { scope: '/' })
  } catch (err) {
    // 등록 실패는 치명적이지 않다(오프라인 캐시만 비활성). 콘솔에만 남긴다.
    console.warn('[pwa] 서비스워커 등록 실패:', err)
  }
}

// 설치 프롬프트 제어 핸들. canInstall이 true일 때 promptInstall()을 호출하면
// 브라우저 기본 설치 UI가 뜬다(사용자 제스처 핸들러 안에서 호출해야 함).
export interface InstallPromptControl {
  // 현재 설치 가능 상태인지(deferred 이벤트 보유 여부).
  canInstall(): boolean
  // 설치 프롬프트를 띄우고 결과를 반환. 불가 상태면 null.
  promptInstall(): Promise<'accepted' | 'dismissed' | null>
  // 상태 변화(설치 가능/완료) 구독. 반환=구독 해제 함수.
  onChange(cb: (canInstall: boolean) => void): () => void
  // 리스너 정리.
  dispose(): void
}

// beforeinstallprompt를 가로채 보관하고, 설치 가능 상태를 노출하는 헬퍼를 만든다.
// 보통 앱 부팅 시 1회 호출해 두고, 설치 버튼 클릭 핸들러에서 promptInstall을 부른다.
export function setupInstallPrompt(): InstallPromptControl {
  // 가로챈 이벤트(나중에 prompt() 호출용). null=현재 설치 불가.
  let deferred: BeforeInstallPromptEvent | null = null
  const listeners = new Set<(canInstall: boolean) => void>()

  const notify = (): void => {
    const can = deferred != null
    for (const cb of listeners) cb(can)
  }

  const onBeforeInstall = (e: Event): void => {
    // 브라우저 기본 미니 인포바를 막고, 우리가 원하는 시점에 prompt()를 호출한다.
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    notify()
  }

  const onInstalled = (): void => {
    // 설치 완료 — deferred 무효화하고 상태 갱신.
    deferred = null
    notify()
  }

  window.addEventListener('beforeinstallprompt', onBeforeInstall)
  window.addEventListener('appinstalled', onInstalled)

  return {
    canInstall: () => deferred != null,
    async promptInstall() {
      if (!deferred) return null
      const evt = deferred
      // prompt()는 1회용 — 호출 후 즉시 무효화한다.
      deferred = null
      notify()
      await evt.prompt()
      const choice = await evt.userChoice
      return choice.outcome
    },
    onChange(cb) {
      listeners.add(cb)
      // 구독 즉시 현재 상태 1회 통지.
      cb(deferred != null)
      return () => listeners.delete(cb)
    },
    dispose() {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      listeners.clear()
    },
  }
}
