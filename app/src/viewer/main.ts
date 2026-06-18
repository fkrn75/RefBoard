// RefBoard 읽기전용 웹 뷰어 진입점(Phase 5 공유).
// 데스크탑 앱과 core(scene/board/theme)를 그대로 공유하되, 편집 입력을 배선하지 않아 읽기전용이 된다.
// 입력은 touch.ts(attachTouchGestures)로 통일 — Pointer Events라 마우스/터치가 함께 처리된다(팬·핀치·탭).
import { Scene } from '../core/scene'
import { deserialize, type BoardState } from '../core/board'
import { applyTheme, getTheme } from '../core/theme'
import { openLightbox } from './lightbox'
import { renderBoardMeta } from './board-meta'
import { attachTouchGestures } from './touch'
import { registerServiceWorker } from './pwa'
import { LocalShareAdapter } from '../core/share-adapter'

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

// ② URL 해시 #/b/<id>에서 보드 읽기(LocalShareAdapter — 같은 브라우저 왕복 검증용. Supabase는 후속).
async function loadHashBoard(): Promise<BoardState | null> {
  const m = location.hash.match(/^#\/b\/(.+)$/)
  if (!m) return null
  try {
    const s = await new LocalShareAdapter().load(m[1])
    return isValidBoard(s) ? s : null
  } catch {
    return null
  }
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

// 화면 좌표 아래의 최상단(z 큰) 이미지 id를 찾는다(라이트박스 진입용).
function hitTest(sx: number, sy: number): string | null {
  if (!board) return null
  const w = scene.screenToWorld(sx, sy)
  const items = [...board.items].sort((a, b) => b.z - a.z) // z 내림차순(위에 있는 것 우선)
  for (const it of items) {
    const a = scene.getItemAABB(it.id)
    if (a && w.x >= a.minX && w.x <= a.maxX && w.y >= a.minY && w.y <= a.maxY) return it.id
  }
  return null
}

// 클릭/탭한 이미지를 라이트박스로 연다(z 오름차순 목록에서 해당 인덱스).
function openLightboxAt(id: string): void {
  if (!board) return
  const list = [...board.items].sort((a, b) => a.z - b.z).map((it) => ({ id: it.id, src: it.src }))
  const idx = list.findIndex((x) => x.id === id)
  if (idx >= 0) openLightbox(list, idx)
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

// ---- 부트 ----
async function boot(): Promise<void> {
  board = loadEmbeddedBoard() ?? (await loadHashBoard())
  if (board) {
    await scene.rebuild(board.items)
    fitAll()
    // 보드 메타(제목/이미지 수) 좌상단. description/author는 공유 메타 확장 시 채움.
    const meta = renderBoardMeta({
      title: board.board.title || 'RefBoard',
      count: board.items.filter((i) => i.type === 'image').length,
    })
    meta.style.position = 'fixed'
    meta.style.top = '16px'
    meta.style.left = '16px'
    meta.style.zIndex = '50'
    document.body.appendChild(meta)
  } else {
    const msg = document.createElement('div')
    msg.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
      'color:var(--rb-text,#aaa);font:14px system-ui,sans-serif;text-align:center;padding:24px'
    msg.textContent = '공유된 보드를 찾을 수 없습니다.'
    host.appendChild(msg)
  }
  void registerServiceWorker() // PWA(오프라인 캐싱) — 미지원/실패 시 조용히 패스
}
void boot()
