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
import { ZOOM_MAX, ZOOM_MIN } from '../core/constants'
import { buildA11yImageLabel, buildCommentBadgeAnchors, hasComment, type CommentBadgeAnchor } from './comment-utils'

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
  repositionCommentBadges() // 카메라가 움직이면 댓글 배지(DOM 오버레이)도 같이 따라와야 한다.
}
function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
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
    .map((it) => ({
      id: it.id,
      src: it.srcs?.orig ?? it.src,
      // 라이트박스 안에서도 댓글을 읽을 수 있게(모바일에서 호버 툴팁이 없던 결함 보완).
      comment: hasComment(it) ? it.comment : undefined,
    }))
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
    // 댓글이 있으면 라벨에 함께 담아, 스크린리더 사용자도 목록만으로 댓글 유무·내용을 알 수 있게 한다
    // (터치 사용자와 동일했던 "댓글 발견 불가" 결함이 비시각 사용자에게도 있었다).
    btn.textContent = buildA11yImageLabel(i, ordered.length, hasComment(it) ? (it.comment ?? null) : null)
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
  // 롱프레스(≈400ms): 터치에는 호버가 없어 댓글이 안 보이던 결함 보완(배지 탭과 동일한 시트를 연다).
  // 발동하면 touch.ts가 onTap을 억제하므로 라이트박스가 동시에 열리지 않는다.
  onLongPress: (x, y) => {
    const it = hitTestItem(x, y, hasComment)
    if (it && hasComment(it)) showCommentSheet(it.comment ?? '')
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
  const it = hitTestItem(sx, sy, hasComment)
  return it && hasComment(it) ? (it.comment ?? null) : null
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

// 마우스 이동 시에만 갱신(터치는 탭→라이트박스가 우선이라 호버 대신 배지/롱프레스로 대체한다 — 아래).
host.addEventListener('mousemove', (e) => {
  const rect = host.getBoundingClientRect()
  const text = commentAt(e.clientX - rect.left, e.clientY - rect.top)
  if (text) showCommentTip(text, e.clientX, e.clientY)
  else hideCommentTip()
})
// 캔버스를 벗어나거나 카메라가 움직이면(휠/팬) 위치가 어긋나므로 숨긴다.
host.addEventListener('mouseleave', hideCommentTip)
host.addEventListener('wheel', hideCommentTip, { passive: true })

// ---- 댓글 배지(데스크탑·모바일 공통 발견 가능성) ----
// 호버 툴팁(위)은 마우스 전용이라 터치 기기에서는 댓글의 존재 자체를 알 방법이 없었다(감사 지적).
// 댓글이 있는 이미지 우상단에 작은 말풍선 배지를 항상 그려 두 플랫폼 모두에서 발견 가능하게 한다.
// 캔버스는 PixiJS 단일 레이어라 아이템별 DOM이 없으므로, 배지는 아이템의 월드 AABB를 화면 좌표로
// 투영해 만든 별도 DOM 오버레이다 — 카메라(cam)가 바뀔 때마다 repositionCommentBadges()로 따라간다.
const badgeLayer = document.createElement('div')
// 레이어 자체는 클릭을 통과시키고(캔버스 팬/탭을 가리지 않게), 배지 각각만 pointer-events:auto.
badgeLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:55'
document.body.appendChild(badgeLayer)

let badgeAnchors: CommentBadgeAnchor[] = []
const badgeEls = new Map<string, HTMLButtonElement>()

// 월드 좌표 → 화면(뷰포트) 좌표. scene.screenToWorld의 역변환(둘 다 cam 기준 동일 아핀 변환 공유).
function worldToScreen(wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y }
}

// 말풍선 아이콘 — 플랫폼별 이모지 렌더 차이를 피하려 인라인 SVG로 그린다.
const COMMENT_BADGE_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path ' +
  'd="M4 4h16v12H8l-4 4V4z" fill="currentColor"/></svg>'

function makeCommentBadgeEl(anchor: CommentBadgeAnchor): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  // 스크린리더는 배지만으로도 어떤 댓글인지 바로 알 수 있어야 한다(a11y).
  btn.setAttribute('aria-label', `댓글 보기: ${anchor.comment}`)
  btn.innerHTML = COMMENT_BADGE_ICON
  btn.style.cssText = [
    'position:fixed',
    'width:22px',
    'height:22px',
    'transform:translate(-50%,-50%)', // 앵커(AABB 우상단)를 배지 중심으로.
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'border-radius:50%',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:var(--rb-accent, #3a7afe)',
    'color:var(--rb-accent-fg, #fff)',
    'cursor:pointer',
    'pointer-events:auto', // 레이어는 통과, 배지 자체는 클릭 가능.
    'box-shadow:0 2px 6px rgba(0,0,0,.35)',
  ].join(';')
  // 배지는 host(캔버스) 밖의 document.body 자식이라 클릭이 host로 버블링되지 않는다 —
  // 라이트박스(탭) 핸들러와 자연히 충돌하지 않는다(별도 stopPropagation 불필요).
  btn.addEventListener('click', () => showCommentSheet(anchor.comment))
  return btn
}

// 보드 로드/재빌드 시 댓글 있는 이미지 목록으로 배지를 다시 만든다.
function rebuildCommentBadges(b: BoardState): void {
  badgeLayer.innerHTML = ''
  badgeEls.clear()
  badgeAnchors = buildCommentBadgeAnchors(b.items, (id) => scene.getItemAABB(id))
  for (const a of badgeAnchors) {
    const el = makeCommentBadgeEl(a)
    badgeEls.set(a.id, el)
    badgeLayer.appendChild(el)
  }
  repositionCommentBadges()
}

// 카메라(팬/줌)가 바뀔 때마다 배지 화면 위치를 다시 계산한다(applyCam에서 호출).
function repositionCommentBadges(): void {
  for (const a of badgeAnchors) {
    const el = badgeEls.get(a.id)
    if (!el) continue
    const s = worldToScreen(a.worldX, a.worldY)
    el.style.left = `${s.x}px`
    el.style.top = `${s.y}px`
  }
}

// ---- 댓글 시트(모바일: 배지 탭 · 롱프레스 공용 표시) ----
// 위치 계산이 필요한 툴팁과 달리 화면 하단에 고정되는 바텀시트라 터치 지점과 무관하게 항상 안전하다.
const commentSheetBackdrop = document.createElement('div')
// 시트가 열려 있는 동안만 전체 화면 탭을 가로채 "바깥 탭으로 닫기"를 구현한다.
commentSheetBackdrop.style.cssText = 'position:fixed;inset:0;z-index:70;display:none'
commentSheetBackdrop.addEventListener('click', hideCommentSheet)

const commentSheet = document.createElement('div')
commentSheet.setAttribute('role', 'region')
commentSheet.setAttribute('aria-label', '이미지 댓글')
commentSheet.setAttribute('aria-live', 'polite') // 열리는 순간 스크린리더가 내용을 읽도록.
commentSheet.style.cssText = [
  'position:fixed',
  'left:0',
  'right:0',
  'bottom:0',
  'z-index:71',
  'display:none',
  'box-sizing:border-box',
  'max-height:40vh',
  'overflow-y:auto',
  'padding:16px 44px 16px 18px',
  'padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px))', // 노치 기기 하단 안전영역.
  'border-radius:16px 16px 0 0',
  'font:14px/1.6 system-ui,Segoe UI,sans-serif',
  'white-space:pre-wrap',
  'word-break:break-word',
  'background:var(--rb-panel-bg, #252526)',
  'color:var(--rb-text, #e6e6e6)',
  'border-top:1px solid var(--rb-panel-border, #3a3a3a)',
  'box-shadow:0 -8px 28px rgba(0,0,0,.4)',
].join(';')
commentSheet.addEventListener('click', (e) => e.stopPropagation()) // 내용 클릭이 백드롭 닫기로 새지 않게.

const commentSheetClose = document.createElement('button')
commentSheetClose.type = 'button'
commentSheetClose.setAttribute('aria-label', '댓글 닫기')
commentSheetClose.textContent = '✕'
commentSheetClose.style.cssText = [
  'position:absolute',
  'top:10px',
  'right:10px',
  'width:32px',
  'height:32px',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'border:none',
  'border-radius:50%',
  'cursor:pointer',
  'font-size:15px',
  'line-height:1',
  'background:transparent',
  'color:var(--rb-text-dim, #999)',
].join(';')
commentSheetClose.addEventListener('click', hideCommentSheet)

const commentSheetText = document.createElement('div')
commentSheet.appendChild(commentSheetClose)
commentSheet.appendChild(commentSheetText)
document.body.appendChild(commentSheetBackdrop)
document.body.appendChild(commentSheet)

function showCommentSheet(text: string): void {
  commentSheetText.textContent = text
  commentSheetBackdrop.style.display = 'block'
  commentSheet.style.display = 'block'
}
function hideCommentSheet(): void {
  commentSheetBackdrop.style.display = 'none'
  commentSheet.style.display = 'none'
}
// Esc로도 닫을 수 있게(키보드 사용자 — 배지는 버튼이라 포커스 가능, 시트는 배경 탭만으론 부족).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideCommentSheet()
})

// 보드를 화면에 렌더(임베드/해시 공통 경로).
async function renderBoard(b: BoardState): Promise<void> {
  board = b
  await scene.rebuild(b.items)
  fitAll()
  // 댓글 배지: AABB가 확정된 뒤(rebuild 이후) 계산해야 위치가 맞는다.
  rebuildCommentBadges(b)
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

function makeCenterButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.style.cssText =
    'padding:9px 14px;border-radius:8px;border:0;background:#444;color:#fff;cursor:pointer;font-size:14px'
  btn.addEventListener('click', onClick)
  return btn
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
    else if (reason === 'expired')
      showCenter('만료된 공유 링크입니다.', [makeCenterButton('다시 확인', () => location.reload())])
    else showCenter('공유된 보드를 찾을 수 없습니다.')
  }
  void registerServiceWorker() // PWA(오프라인 캐싱) — 미지원/실패 시 조용히 패스
}
void boot()
