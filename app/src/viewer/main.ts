// RefBoard 읽기전용 웹 뷰어 진입점(Phase 5 공유).
// 데스크탑 앱과 core(scene/board/theme)를 그대로 공유하되, 편집 입력을 배선하지 않아 읽기전용이 된다.
// 입력은 touch.ts(attachTouchGestures)로 통일 — Pointer Events라 마우스/터치가 함께 처리된다(팬·핀치·탭).
import { Scene } from '../core/scene'
import { deserialize, isImageItem, type BoardItem, type BoardState } from '../core/board'
import { applyTheme, getTheme } from '../core/theme'
import { openLightbox } from './lightbox'
import { renderBoardMeta } from './board-meta'
import { attachTouchGestures } from './touch'
import { registerServiceWorker } from './pwa'
import { getShareAdapter } from '../core/supabase-share'

const host = document.getElementById('app') as HTMLElement

function isValidBoard(s: BoardState | null): s is BoardState {
  return !!s && typeof s.schema === 'string' && s.schema.startsWith('refboard/')
}

// ① 자기완결 HTML 임베드(<script id="refboard-data">)에서 보드 읽기.
function loadEmbeddedBoard(): BoardState | null {
  const el = document.getElementById('refboard-data')
  if (!el || !el.textContent) return null
  try {
    const s = deserialize(el.textContent)
    return isValidBoard(s) ? s : null
  } catch {
    return null
  }
}

// ② URL 해시 #/b/<id>에서 board id 추출(실제 로드는 boot에서 어댑터로 — 사유별 화면 분기).
function hashBoardId(): string | null {
  const m = location.hash.match(/^#\/b\/(.+)$/)
  return m ? m[1] : null
}

applyTheme(getTheme())
const scene = await Scene.create(host)

// ---- 카메라(읽기전용: 줌/팬만) ----
const cam = { x: 0, y: 0, zoom: 1 }
function applyCam(): void {
  scene.setCamera(cam.x, cam.y, cam.zoom)
}
function clampZoom(z: number): number {
  return Math.min(20, Math.max(0.05, z))
}
// 전체 보기(콘텐츠 AABB가 화면에 꽉 차도록).
function fitAll(pad = 0.9): void {
  const b = scene.contentBounds()
  if (!b) return
  const W = host.clientWidth
  const H = host.clientHeight
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  cam.zoom = clampZoom(Math.min(W / bw, H / bh) * pad)
  cam.x = W / 2 - ((b.minX + b.maxX) / 2) * cam.zoom
  cam.y = H / 2 - ((b.minY + b.maxY) / 2) * cam.zoom
  applyCam()
}

// 현재 보드(부트에서 채움). 라이트박스 hit 판정에 사용.
let board: BoardState | null = null

// 화면 좌표 아래의 최상단(z 큰) "이미지" id를 찾는다(라이트박스 진입용).
// 노트/드로잉은 라이트박스 대상이 아니므로 isImageItem으로 걸러 이미지만 적중시킨다.
function hitTest(sx: number, sy: number): string | null {
  return hitTestItem(sx, sy, (it) => isImageItem(it))?.id ?? null
}

// 화면 좌표 아래의 최상단(z 큰) 아이템을 조건(pred)에 맞는 것 중에서 찾는다.
// 라이트박스(이미지)·댓글 호버(이미지+comment) 등 용도별로 pred만 바꿔 재사용한다.
function hitTestItem(sx: number, sy: number, pred: (it: BoardItem) => boolean): BoardItem | null {
  if (!board) return null
  const w = scene.screenToWorld(sx, sy)
  const items = [...board.items].sort((a, b) => b.z - a.z) // z 내림차순(위에 있는 것 우선)
  for (const it of items) {
    if (!pred(it)) continue
    const a = scene.getItemAABB(it.id)
    if (a && w.x >= a.minX && w.x <= a.maxX && w.y >= a.minY && w.y <= a.maxY) return it
  }
  return null
}

// 클릭/탭한 이미지를 라이트박스로 연다(z 오름차순 "이미지" 목록에서 해당 인덱스).
// 노트/드로잉은 src가 없어 라이트박스 항목이 될 수 없으므로 isImageItem으로 거른다
// (걸러야 인덱스가 어긋나지 않고 undefined src가 섞이지 않는다).
function openLightboxAt(id: string): void {
  if (!board) return
  // 라이트박스는 풀스크린이라 원본(srcs.orig)을 띄운다 — 없으면 src 폴백(편집·하위호환).
  const list = [...board.items]
    .filter(isImageItem)
    .sort((a, b) => a.z - b.z)
    .map((it) => ({ id: it.id, src: it.srcs?.orig ?? it.src }))
  const idx = list.findIndex((x) => x.id === id)
  if (idx >= 0) openLightbox(list, idx)
}

// 접근성: 키보드/스크린리더용 이미지 목록(시각적으로 숨김, 포커스·활성화 가능).
// 보드는 PixiJS 캔버스 한 장이라 비텍스트 사용자에겐 콘텐츠가 0이므로,
// 각 이미지를 라이트박스로 여는 버튼 목록을 대체 수단으로 제공한다(a11y P1·P2).
function buildA11yImageList(b: BoardState): HTMLElement {
  const nav = document.createElement('nav')
  nav.setAttribute('aria-label', '보드 이미지 목록')
  // sr-only 관용구 — 시각적으로 숨기되 포커스/스크린리더 접근은 유지.
  nav.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;' +
    'clip:rect(0 0 0 0);white-space:nowrap;border:0'
  const ordered = [...b.items].filter(isImageItem).sort((a, c) => a.z - c.z)
  ordered.forEach((it, i) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = `이미지 ${i + 1} 크게 보기 (총 ${ordered.length}개)`
    btn.addEventListener('click', () => openLightboxAt(it.id))
    nav.appendChild(btn)
  })
  return nav
}

// 휠 줌(커서 고정점).
host.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const rect = host.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const before = scene.screenToWorld(mx, my)
    cam.zoom = clampZoom(cam.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))
    cam.x = mx - before.x * cam.zoom
    cam.y = my - before.y * cam.zoom
    applyCam()
  },
  { passive: false },
)

// 포인터 제스처: 1손가락/마우스 드래그=팬, 2손가락=핀치 줌, 짧은 탭=라이트박스.
attachTouchGestures(host, {
  onPan: (dx, dy) => {
    cam.x += dx
    cam.y += dy
    applyCam()
  },
  onPinch: (factor, cx, cy) => {
    const nz = clampZoom(cam.zoom * factor)
    const applied = nz / cam.zoom // 줌 클램프를 반영한 실제 적용 비율(중심 고정 보정에 사용)
    cam.x = cx - (cx - cam.x) * applied
    cam.y = cy - (cy - cam.y) * applied
    cam.zoom = nz
    applyCam()
  },
  onTap: (x, y) => {
    const id = hitTest(x, y)
    if (id) openLightboxAt(id)
  },
})
host.addEventListener('contextmenu', (e) => e.preventDefault())
window.addEventListener('resize', () => fitAll())

// ---- 댓글(comment) 읽기전용 표시 ----
// 보드는 PixiJS 캔버스 한 장이라 이미지에 부착된 메모(BoardImage.comment)를 표시할 DOM이 없다.
// 그래서 커서가 댓글이 있는 이미지 위에 올라가면 가벼운 플로팅 툴팁으로 메모를 보여준다(읽기전용).
// 노트/드로잉에는 comment 필드가 없으므로(스키마상 이미지 전용) 이미지만 대상으로 한다.
const commentTip = document.createElement('div')
commentTip.setAttribute('role', 'tooltip')
commentTip.style.cssText = [
  'position:fixed',
  'z-index:60', // 메타(50)보다 위, 라이트박스(10001)보다 아래
  'max-width:280px',
  'padding:8px 12px',
  'border-radius:8px',
  'font:13px/1.45 system-ui,Segoe UI,sans-serif',
  'white-space:pre-wrap', // 줄바꿈 보존
  'word-break:break-word',
  'pointer-events:none', // 입력(팬/탭)을 가로채지 않게
  'background:var(--rb-panel-bg, rgba(40,40,40,.92))',
  'color:var(--rb-text, #e6e6e6)',
  'border:1px solid var(--rb-panel-border, #3a3a3a)',
  'box-shadow:0 6px 24px rgba(0,0,0,.4)',
  '-webkit-backdrop-filter:blur(6px)',
  'backdrop-filter:blur(6px)',
  'display:none', // 기본 숨김
].join(';')
document.body.appendChild(commentTip)

// 화면 좌표에 위치한 "댓글 있는 이미지"의 comment를 반환(없으면 null).
function commentAt(sx: number, sy: number): string | null {
  const it = hitTestItem(sx, sy, (i) => isImageItem(i) && !!i.comment && i.comment.trim().length > 0)
  return it && isImageItem(it) ? (it.comment ?? null) : null
}

// 댓글 툴팁을 커서 근처에 표시한다(화면 밖으로 넘치지 않게 가장자리에서 반대편으로 뒤집음).
function showCommentTip(text: string, clientX: number, clientY: number): void {
  commentTip.textContent = text
  commentTip.style.display = 'block'
  const margin = 14
  // 먼저 보이게 한 뒤 크기를 측정해 위치를 보정한다.
  const w = commentTip.offsetWidth
  const h = commentTip.offsetHeight
  let left = clientX + margin
  let top = clientY + margin
  if (left + w > window.innerWidth - 8) left = clientX - margin - w // 오른쪽 넘침 → 왼쪽
  if (top + h > window.innerHeight - 8) top = clientY - margin - h // 아래 넘침 → 위
  commentTip.style.left = Math.max(8, left) + 'px'
  commentTip.style.top = Math.max(8, top) + 'px'
}

function hideCommentTip(): void {
  if (commentTip.style.display !== 'none') commentTip.style.display = 'none'
}

// 마우스 이동 시에만 갱신(터치는 탭→라이트박스라 호버 개념이 약해 생략).
host.addEventListener('mousemove', (e) => {
  const rect = host.getBoundingClientRect()
  const text = commentAt(e.clientX - rect.left, e.clientY - rect.top)
  if (text) showCommentTip(text, e.clientX, e.clientY)
  else hideCommentTip()
})
// 캔버스를 벗어나거나 카메라가 움직이면(휠/팬) 위치가 어긋나므로 숨긴다.
host.addEventListener('mouseleave', hideCommentTip)
host.addEventListener('wheel', hideCommentTip, { passive: true })

// 보드를 화면에 렌더(임베드/해시 공통 경로).
async function renderBoard(b: BoardState): Promise<void> {
  board = b
  await scene.rebuild(b.items)
  fitAll()
  // 보드 메타(제목/이미지 수) 좌상단.
  const meta = renderBoardMeta({
    title: b.board.title || 'RefBoard',
    count: b.items.filter(isImageItem).length,
  })
  meta.style.position = 'fixed'
  meta.style.top = '16px'
  meta.style.left = '16px'
  meta.style.zIndex = '50'
  document.body.appendChild(meta)
  // 키보드/스크린리더 접근 수단(숨김 이미지 목록) — 캔버스만으론 비텍스트 접근이 0이다(a11y P1·P2).
  document.body.appendChild(buildA11yImageList(b))
}

// 중앙 안내 화면(권한/만료/없음/로그인 공통). actions가 있으면 메시지 아래에 버튼을 단다.
function showCenter(message: string, actions: HTMLElement[] = []): void {
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;gap:16px;align-items:center;justify-content:center;' +
    'color:var(--rb-text,#ccc);font:14px system-ui,sans-serif;text-align:center;padding:24px;white-space:pre-line'
  wrap.setAttribute('role', 'status') // 스크린리더가 안내를 읽도록(a11y P3)
  const p = document.createElement('div')
  p.textContent = message
  wrap.appendChild(p)
  for (const a of actions) wrap.appendChild(a)
  host.appendChild(wrap)
}

// 로그인 화면(구글 OAuth + 이메일 매직링크 폴백).
function showLoginScreen(adapter: ReturnType<typeof getShareAdapter>): void {
  const google = document.createElement('button')
  google.type = 'button'
  google.textContent = '구글로 계속하기'
  google.style.cssText =
    'padding:10px 18px;border-radius:8px;border:0;background:#4285f4;color:#fff;cursor:pointer;font-size:14px'
  google.addEventListener('click', () => void adapter.signIn())

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:8px;align-items:center'
  const input = document.createElement('input')
  input.type = 'email'
  input.placeholder = '이메일(매직링크)'
  input.style.cssText =
    'padding:9px 12px;border-radius:8px;border:1px solid #555;background:#222;color:#eee;font-size:14px'
  const send = document.createElement('button')
  send.type = 'button'
  send.textContent = '링크 받기'
  send.style.cssText =
    'padding:9px 14px;border-radius:8px;border:0;background:#444;color:#fff;cursor:pointer;font-size:14px'
  send.addEventListener('click', async () => {
    const email = input.value.trim()
    if (!email) return
    try {
      await adapter.signInWithEmail(email)
      send.textContent = '메일을 확인하세요'
      send.disabled = true
    } catch {
      send.textContent = '실패 — 다시 시도'
    }
  })
  row.appendChild(input)
  row.appendChild(send)

  showCenter('이 보드를 보려면 로그인이 필요합니다.', [google, row])
}

// ---- 부트 ----
async function boot(): Promise<void> {
  // ① 자기완결 HTML 임베드 우선(로그인·네트워크 불필요).
  const embedded = loadEmbeddedBoard()
  if (embedded) {
    await renderBoard(embedded)
    void registerServiceWorker()
    return
  }
  // ② 해시 #/b/<id> → 어댑터 로드(Supabase 키 있으면 클라우드, 없으면 목업).
  const id = hashBoardId()
  if (!id) {
    showCenter('공유된 보드를 찾을 수 없습니다.')
    void registerServiceWorker()
    return
  }
  const adapter = getShareAdapter(location.origin + location.pathname)
  let res
  try {
    res = await adapter.load(id)
  } catch {
    showCenter('보드를 불러오지 못했습니다.\n잠시 후 다시 시도해주세요.')
    void registerServiceWorker()
    return
  }
  if (res.ok && isValidBoard(res.board)) {
    await renderBoard(res.board)
  } else {
    const reason = res.ok ? 'not-found' : res.reason
    if (reason === 'auth-required') showLoginScreen(adapter)
    else if (reason === 'forbidden')
      showCenter('이 보드에 접근할 권한이 없습니다.\n보드 주인에게 초대를 요청하세요.')
    else if (reason === 'expired') showCenter('만료된 공유 링크입니다.')
    else showCenter('공유된 보드를 찾을 수 없습니다.')
  }
  void registerServiceWorker() // PWA(오프라인 캐싱) — 미지원/실패 시 조용히 패스
}
void boot()
