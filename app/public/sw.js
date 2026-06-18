// RefBoard Viewer 서비스워커 — 오프라인 캐시(서버리스 정적 호스팅 대상).
//
// 전략:
//  1) 앱 셸(/, manifest, 아이콘)을 install 시 precache.
//  2) 내비게이션 요청(HTML)은 network-first → 오프라인이면 캐시된 셸('/')로 폴백(SPA).
//  3) 그 외 GET(JS/CSS/이미지/보드 자산)은 cache-first + 백그라운드 캐시 채움.
//  4) 버전(CACHE_VERSION)이 바뀌면 activate에서 옛 캐시를 모두 삭제.
//
// 주의: Vite 번들 산출물은 파일명에 해시가 붙어 빌드 전엔 목록을 알 수 없으므로
// precache 대상에 넣지 않고 런타임 캐시(cache-first)로 자연히 채운다.

// 캐시 버전 — 배포 시 올리면 옛 캐시가 정리된다.
const CACHE_VERSION = 'v1'
const SHELL_CACHE = `refboard-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `refboard-runtime-${CACHE_VERSION}`

// install 시 미리 받아둘 앱 셸 자원(루트 경로 기준).
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/128x128.png',
  '/icons/128x128@2x.png',
  '/icons/icon.png',
]

// 설치: 셸 자원 precache. 일부 자원이 없어도(개별 실패) 설치는 진행되도록 개별 처리.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // addAll은 하나라도 실패하면 전체 실패하므로, 개별 add로 누락에 관대하게 처리.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[sw] precache 실패:', url, err)),
        ),
      )
      // 새 워커를 곧바로 활성화 대기열로(기존 탭의 컨트롤은 activate에서 인수).
      await self.skipWaiting()
    })(),
  )
})

// 활성화: 현재 버전이 아닌 옛 캐시 제거 + 즉시 클라이언트 제어 인수.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

// fetch 가로채기.
self.addEventListener('fetch', (event) => {
  const req = event.request

  // GET 외(POST 등)는 그대로 통과 — 캐시 대상 아님.
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // 교차 출처 요청(외부 CDN 등)은 캐시 정책을 강제하지 않고 통과시킨다
  // (opaque 응답 캐시는 용량만 키울 수 있어 보수적으로 제외).
  if (url.origin !== self.location.origin) return

  // 내비게이션(주소창/링크로 HTML 문서 요청): network-first, 실패 시 셸 폴백.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req))
    return
  }

  // 나머지 동일 출처 GET: cache-first(이미지/번들/보드 자산 오프라인 재생).
  event.respondWith(cacheFirst(req))
})

// network-first: 네트워크 우선, 성공 시 셸 캐시 갱신, 실패 시 캐시('/' 폴백) 사용.
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const res = await fetch(req)
    // 정상 응답이면 셸 캐시에 사본 저장(다음 오프라인 대비).
    if (res && res.ok) cache.put(req, res.clone())
    return res
  } catch {
    // 오프라인: 동일 요청 캐시 → 없으면 루트 셸 → 그래도 없으면 503.
    const cached = (await cache.match(req)) || (await cache.match('/'))
    return cached || new Response('오프라인 상태이며 캐시가 없습니다.', { status: 503 })
  }
}

// cache-first: 캐시에 있으면 즉시 반환, 없으면 네트워크 후 런타임 캐시에 저장.
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE)
  const cached = await cache.match(req)
  if (cached) return cached
  try {
    const res = await fetch(req)
    // ok 응답만 캐시(부분응답 206/오류는 제외).
    if (res && res.ok && res.status === 200) cache.put(req, res.clone())
    return res
  } catch (err) {
    // 네트워크 실패 & 캐시 미스 — 에러를 그대로 전파(이미지 깨짐 등으로 표시).
    throw err
  }
}
