// 내 공유 보드 관리 패널 — 클라우드에 올린 보드를 목록으로 보고 공개전환·링크복사·삭제한다.
// share-dialog.ts의 모달 패턴(백드롭+패널, Esc·바깥클릭 닫기, theme --rb-* 변수)을 그대로 따른다.
// 데이터/삭제/공개전환은 ShareAdapter(listMine/remove/setPublic)에 위임 — 이 모듈은 DOM만 담당한다.

import type { ShareAdapter, BoardSummary } from './share-adapter'
import { MODAL_Z_INDEX } from './constants'
import { createFocusTrap } from './modal'
import { openConfirmDialog } from './dialog'

// 동시에 하나만 — 이미 떠 있으면 무시(중복 모달 방지).
let openRoot: HTMLDivElement | null = null

export interface BoardManagerOptions {
  adapter: ShareAdapter
  // 토스트는 main.ts 소유라 콜백으로 받는다(이 모듈은 DOM만 담당).
  onToast?: (msg: string, ok?: boolean) => void
  // 편집 앱으로 불러오기(클라우드 보드 → 편집). main이 load+restore를 담당. 미지정이면 버튼 숨김.
  onLoadIntoEditor?: (id: string) => void | Promise<void>
}

export function openBoardManager(options: BoardManagerOptions): void {
  if (openRoot) return
  const { adapter } = options
  const toast = (m: string, ok = true): void => options.onToast?.(m, ok)

  // ---- 백드롭 + 패널 ----
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', '내 공유 보드')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    `z-index:${MODAL_Z_INDEX}`,
    'display:flex',
    'justify-content:center',
    'align-items:flex-start',
    'padding-top:10vh',
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'font:14px system-ui,Segoe UI,sans-serif',
  ].join(';')

  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:min(560px,94vw)',
    'max-height:78vh',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'border-radius:12px',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')
  panel.addEventListener('mousedown', (e) => e.stopPropagation())

  // ---- 공통 버튼 팩토리 ----
  const makeButton = (label: string): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.style.cssText = [
      'flex:none',
      'padding:5px 10px',
      'border-radius:7px',
      'border:1px solid var(--rb-panel-border, #3a3a3a)',
      'background:transparent',
      'color:var(--rb-text, #e6e6e6)',
      'cursor:pointer',
      'font:inherit',
      'font-size:12px',
    ].join(';')
    return b
  }
  const makeIconButton = (glyph: string, aria: string): HTMLButtonElement => {
    const b = makeButton(glyph)
    b.setAttribute('aria-label', aria)
    b.title = aria
    b.style.width = '32px'
    b.style.padding = '5px 0'
    return b
  }

  // ---- 헤더 ----
  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--rb-panel-border, #3a3a3a)'
  const title = document.createElement('strong')
  title.textContent = '내 공유 보드'
  title.style.cssText = 'font-size:14px;flex:1 1 auto'
  const refreshBtn = makeButton('새로고침')
  const closeBtn = makeIconButton('✕', '닫기')
  header.append(title, refreshBtn, closeBtn)

  // ---- 본문(목록) ----
  const body = document.createElement('div')
  body.style.cssText = 'padding:10px 14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px'

  panel.append(header, body)
  backdrop.appendChild(panel)
  const focusTrap = createFocusTrap(backdrop)

  // ---- 닫기 처리 ----
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') {
      e.stopPropagation()
      focusTrap.handleKeydown(e)
    } else {
      // 모달이 떠 있는 동안 전역 단축키 전파만 차단(캡처 단계).
      e.stopPropagation()
    }
  }
  const close = (): void => {
    document.removeEventListener('keydown', onKey, true)
    focusTrap.dispose()
    backdrop.remove()
    openRoot = null
  }
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })
  closeBtn.addEventListener('click', close)
  refreshBtn.addEventListener('click', () => void renderList())

  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(backdrop)
  openRoot = backdrop
  focusTrap.activate()
  void renderList()

  // ---- 목록 렌더 ----
  async function renderList(): Promise<void> {
    setMessage('불러오는 중…')
    const user = await adapter.getCurrentUser().catch(() => null)
    if (!user) {
      setMessage('로그인하면 내가 공유한 보드를 관리할 수 있어요.')
      const signin = makeButton('구글로 로그인')
      signin.style.alignSelf = 'center'
      signin.addEventListener('click', () => void adapter.signIn().catch((e) => toast(errMsg(e), false)))
      body.appendChild(signin)
      return
    }
    let boards: BoardSummary[]
    try {
      boards = await adapter.listMine()
    } catch (e) {
      setMessage('목록을 불러오지 못했습니다: ' + errMsg(e))
      return
    }
    if (boards.length === 0) {
      setMessage('아직 공유한 보드가 없습니다.')
      return
    }
    body.innerHTML = ''
    for (const b of boards) body.appendChild(renderRow(b))
  }

  // ---- 한 보드 행(배지 · 제목/날짜 · 링크복사/공개전환/삭제) ----
  function renderRow(b: BoardSummary): HTMLElement {
    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--rb-panel-border, #3a3a3a);border-radius:8px'

    const badge = document.createElement('span')
    badge.textContent = b.isPublic ? '공개' : '비공개'
    badge.style.cssText =
      'flex:none;font-size:11px;padding:2px 8px;border-radius:999px;' +
      (b.isPublic
        ? 'background:rgba(31,122,77,.18);color:#46c98a;border:1px solid #1f7a4d'
        : 'background:rgba(136,136,136,.15);color:#aaa;border:1px solid #555')

    const info = document.createElement('div')
    info.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px'
    const name = document.createElement('span')
    name.textContent = b.title
    name.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    const meta = document.createElement('span')
    meta.textContent = formatDate(b.createdAt) + (b.status !== 'ready' ? ' · 업로드 중' : '')
    meta.style.cssText = 'font-size:11px;color:var(--rb-text-dim, #888)'
    info.append(name, meta)

    // 뷰어로 바로 열기(새 탭).
    const openBtn = makeIconButton('👁', '뷰어로 열기')
    openBtn.addEventListener('click', () => {
      window.open(adapter.getShareUrl(b.id), '_blank', 'noopener')
    })

    const copyBtn = makeIconButton('🔗', '링크 복사')
    copyBtn.addEventListener('click', async () => {
      const url = adapter.getShareUrl(b.id)
      try {
        await navigator.clipboard.writeText(url)
        toast('링크 복사됨', true)
      } catch {
        toast('링크: ' + url, true)
      }
    })

    const pubBtn = makeButton(b.isPublic ? '비공개로' : '공개로')
    pubBtn.addEventListener('click', async () => {
      pubBtn.disabled = true
      try {
        await adapter.setPublic(b.id, !b.isPublic)
        toast(b.isPublic ? '비공개로 전환했어요' : '공개로 전환했어요', true)
        await renderList()
      } catch (e) {
        toast(errMsg(e), false)
        pubBtn.disabled = false
      }
    })

    const delBtn = makeIconButton('🗑', '삭제')
    delBtn.style.color = '#e06c6c'
    delBtn.addEventListener('click', async () => {
      const ok = await openConfirmDialog({
        title: '공유 보드 삭제',
        message: `"${b.title}" 보드를 삭제할까요?\n이 링크는 더 이상 열 수 없습니다.`,
        confirmLabel: '삭제',
        destructive: true,
      })
      if (!ok) return
      delBtn.disabled = true
      try {
        await adapter.remove(b.id)
        toast('삭제했어요', true)
        await renderList()
      } catch (e) {
        toast(errMsg(e), false)
        delBtn.disabled = false
      }
    })

    // 편집 앱으로 불러오기(클라우드 → 편집). 콜백이 있을 때만 노출.
    let loadBtn: HTMLButtonElement | null = null
    if (options.onLoadIntoEditor) {
      loadBtn = makeIconButton('✏️', '편집 앱으로 불러오기')
      const b2 = loadBtn
      b2.addEventListener('click', async () => {
        b2.disabled = true
        try {
          await options.onLoadIntoEditor!(b.id)
          close() // 불러온 뒤 패널을 닫아 편집 화면으로 돌아간다.
        } catch (e) {
          toast(errMsg(e), false)
          b2.disabled = false
        }
      })
    }

    const actions: HTMLElement[] = [openBtn, copyBtn]
    if (loadBtn) actions.push(loadBtn)
    actions.push(pubBtn, delBtn)
    row.append(badge, info, ...actions)
    return row
  }

  // 안내/로딩/빈 상태 메시지(목록을 비우고 가운데 한 줄).
  function setMessage(text: string): void {
    body.innerHTML = ''
    const p = document.createElement('div')
    p.textContent = text
    p.style.cssText = 'padding:18px 6px;color:var(--rb-text-dim, #888);text-align:center'
    body.appendChild(p)
  }
}

// ISO 날짜 → 'YYYY.MM.DD'(없거나 파싱 불가면 빈 문자열).
function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}.${mm}.${dd}`
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
