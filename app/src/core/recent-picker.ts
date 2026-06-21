// 최근 파일 모달 — "마지막 세션 복원" 버튼 + 최근 연 파일 목록을 한 모달에서 보여준다.
//
// 설계 원칙:
//  - settings-panel.ts / share-dialog.ts의 모달 패턴(백드롭+패널, 캡처단계 키 처리, Esc/바깥클릭 닫기,
//    theme.ts의 --rb-* 변수 직접 참조)을 그대로 따른다.
//  - 이 모듈은 "표시 + 사용자 선택 통지"만 한다. 실제 복원/목록비우기 동작은 콜백으로 호출측(main)에 위임.
//      · onRestoreLast(): '마지막 세션 복원' 클릭 → main이 restore(getLastSession())
//      · onClear?():       '최근 목록 비우기' 클릭 → main이 clearRecent()
//  - ⚠️ 최근 "목록"은 메타데이터(name/ts/size)만 보관하고 보드 내용 자체는 저장하지 않는다.
//    따라서 개별 항목은 정보성 표시일 뿐, 클릭해도 그 보드를 다시 열 수 없다(안내 문구 1줄로 명시).
//    실제 "이어 열기"가 가능한 것은 마지막 세션(getLastSession) 하나뿐이다.

import type { RecentEntry } from './recent'

// 동시에 하나만 — 이미 떠 있으면 무시(중복 모달 방지).
let openRoot: HTMLDivElement | null = null
let onDocKeydown: ((e: KeyboardEvent) => void) | null = null

// 최근 파일 모달을 연다.
//  - entries: 표시할 최근 항목(보통 getRecent()). 비어 있으면 "최근 항목 없음" 안내.
//  - hasLastSession: 마지막 세션 저장본 존재 여부(보통 getLastSession() != null).
//  - onRestoreLast: 복원 버튼 클릭 콜백(모달은 닫고 호출측이 실제 복원).
//  - onClear: 목록 비우기 콜백(선택). 없으면 비우기 버튼을 숨긴다.
export function openRecentPicker(opts: {
  entries: RecentEntry[]
  hasLastSession: boolean
  onRestoreLast: () => void
  onClear?: () => void
}): void {
  if (openRoot) return // 이미 열려 있으면 중복 생성 방지

  // ---- 백드롭(화면 전체 딤) ----
  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', '최근 파일')
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10000',
    'display:flex',
    'justify-content:center',
    'align-items:flex-start',
    'padding-top:10vh',
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'font:14px system-ui,Segoe UI,sans-serif',
  ].join(';')

  // ---- 패널 ----
  const panel = document.createElement('div')
  panel.style.cssText = [
    'width:min(480px,94vw)',
    'max-height:80vh',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'border-radius:12px',
    'background:var(--rb-panel-bg, #252526)',
    'color:var(--rb-text, #e6e6e6)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'box-shadow:0 12px 40px rgba(0,0,0,.5)',
    // glass 테마 반투명 패널 유리 질감(다른 테마는 불투명이라 무해).
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')
  panel.addEventListener('mousedown', (e) => e.stopPropagation())

  // ---- 헤더(제목 + 닫기) ----
  const header = document.createElement('div')
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:8px',
    'padding:12px 14px',
    'border-bottom:1px solid var(--rb-panel-border, #3a3a3a)',
    'flex:none',
  ].join(';')
  const title = document.createElement('strong')
  title.textContent = '최근 파일'
  title.style.cssText = 'font-size:14px;flex:1 1 auto'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '닫기')
  closeBtn.style.cssText = iconButtonCss()
  closeBtn.addEventListener('click', () => close())
  header.appendChild(title)
  header.appendChild(closeBtn)

  // ---- 본문(스크롤 영역) ----
  const body = document.createElement('div')
  body.style.cssText = ['overflow-y:auto', 'padding:14px', 'flex:1 1 auto', 'min-height:0', 'display:flex', 'flex-direction:column', 'gap:14px'].join(';')

  // 1) 마지막 세션 복원 영역.
  body.appendChild(buildRestoreSection(opts.hasLastSession, () => {
    close()
    opts.onRestoreLast()
  }))

  // 2) 최근 항목 목록.
  body.appendChild(buildRecentList(opts.entries))

  // ---- 푸터(목록 비우기 / 닫기) ----
  const footer = document.createElement('div')
  footer.style.cssText = [
    'display:flex',
    'justify-content:flex-end',
    'gap:8px',
    'padding:12px 14px',
    'border-top:1px solid var(--rb-panel-border, #3a3a3a)',
    'flex:none',
  ].join(';')

  // 목록 비우기(콜백이 있고 항목이 있을 때만 의미). 콜백 없으면 버튼 자체를 두지 않는다.
  if (opts.onClear && opts.entries.length > 0) {
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.textContent = '목록 비우기'
    clearBtn.style.cssText = secondaryButtonCss()
    clearBtn.style.marginRight = 'auto' // 좌측으로 밀어 닫기와 분리
    clearBtn.addEventListener('click', () => {
      opts.onClear?.()
      close()
    })
    footer.appendChild(clearBtn)
  }

  const doneBtn = document.createElement('button')
  doneBtn.type = 'button'
  doneBtn.textContent = '닫기'
  doneBtn.style.cssText = secondaryButtonCss()
  doneBtn.addEventListener('click', () => close())
  footer.appendChild(doneBtn)

  // ---- 조립 ----
  panel.appendChild(header)
  panel.appendChild(body)
  panel.appendChild(footer)
  backdrop.appendChild(panel)

  // 바깥(백드롭) 클릭 = 닫기.
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })

  // 키 입력은 캡처 단계에서 처리해 캔버스 단축키와 충돌하지 않게 한다(settings-panel과 동일 패턴).
  onDocKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    // 그 외 키는 전역 단축키로 전파만 차단.
    e.stopPropagation()
  }
  document.addEventListener('keydown', onDocKeydown, true)

  // ---- 표시 ----
  document.body.appendChild(backdrop)
  openRoot = backdrop
}

// 모달을 닫고 DOM·전역 리스너를 정리한다(중복 호출 안전).
function close(): void {
  if (!openRoot) return
  if (onDocKeydown) {
    document.removeEventListener('keydown', onDocKeydown, true)
    onDocKeydown = null
  }
  openRoot.remove()
  openRoot = null
}

// ============================================================
//  섹션 빌더
// ============================================================

// "마지막 세션 복원" 섹션. hasLastSession=false면 버튼을 비활성하고 안내를 바꾼다.
function buildRestoreSection(hasLastSession: boolean, onRestore: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:12px',
    'padding:12px',
    'border-radius:10px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:var(--rb-app-bg, #1e1e1e)',
  ].join(';')

  // 좌측 설명.
  const textCol = document.createElement('div')
  textCol.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px'
  const head = document.createElement('div')
  head.textContent = '마지막 세션'
  head.style.cssText = 'font-size:13px;font-weight:600'
  const sub = document.createElement('div')
  sub.textContent = hasLastSession
    ? '직전에 작업하던 보드를 그대로 이어서 엽니다.'
    : '저장된 마지막 세션이 없습니다.'
  sub.style.cssText = 'font-size:12px;color:var(--rb-text-dim, #777)'
  textCol.appendChild(head)
  textCol.appendChild(sub)

  // 우측 복원 버튼(주 액션).
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = '복원'
  btn.style.cssText = primaryButtonCss()
  btn.disabled = !hasLastSession
  if (!hasLastSession) {
    btn.style.opacity = '0.4'
    btn.style.cursor = 'default'
  } else {
    btn.addEventListener('click', onRestore)
  }

  wrap.appendChild(textCol)
  wrap.appendChild(btn)
  return wrap
}

// 최근 항목 목록 섹션. 항목은 정보성(클릭 불가)이며, 그 사실을 안내 문구로 명시한다.
function buildRecentList(entries: RecentEntry[]): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px'

  // 섹션 제목 + 안내(개별 항목은 다시 열 수 없음).
  const heading = document.createElement('div')
  heading.textContent = '최근 연 파일'
  heading.style.cssText = 'font-size:11px;font-weight:600;color:var(--rb-text-dim, #777);letter-spacing:.04em;padding:0 2px'
  wrap.appendChild(heading)

  // 항목이 없으면 빈 안내만.
  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = '최근 연 파일이 없습니다.'
    empty.style.cssText = 'font-size:13px;color:var(--rb-text-dim, #777);padding:8px 2px'
    wrap.appendChild(empty)
    return wrap
  }

  // 목록 컨테이너.
  const list = document.createElement('div')
  list.style.cssText = 'display:flex;flex-direction:column;gap:2px'
  for (const e of entries) list.appendChild(buildRecentRow(e))
  wrap.appendChild(list)

  // ⚠️ 정보성 안내 — 목록은 메타만 보관하므로 개별 항목 클릭으로는 보드를 열 수 없다.
  const note = document.createElement('div')
  note.textContent = '※ 목록은 기록용입니다. 다시 열려면 파일을 직접 불러오세요. (이어 열기는 "마지막 세션"만 가능)'
  note.style.cssText = 'font-size:11px;color:var(--rb-text-dim, #777);padding:6px 2px 0;line-height:1.5'
  wrap.appendChild(note)

  return wrap
}

// 최근 항목 1행: [파일명] [n분 전 · 크기]. 클릭 불가(정보성)라 hover/cursor 강조를 두지 않는다.
function buildRecentRow(e: RecentEntry): HTMLElement {
  const row = document.createElement('div')
  row.style.cssText = [
    'display:flex',
    'align-items:baseline',
    'gap:10px',
    'padding:7px 8px',
    'border-radius:6px',
    'background:var(--rb-app-bg, #1e1e1e)',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
  ].join(';')

  // 파일명(길면 말줄임).
  const name = document.createElement('span')
  name.textContent = e.name
  name.title = e.name
  name.style.cssText = 'flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px'
  row.appendChild(name)

  // 메타(시각 + 크기). 고정 폭은 두지 않고 우측에 자연스레 붙인다.
  const meta = document.createElement('span')
  meta.textContent = formatMeta(e)
  meta.style.cssText = 'flex:none;font-size:11px;color:var(--rb-text-dim, #777);white-space:nowrap'
  row.appendChild(meta)

  return row
}

// "n분 전 · 12KB" 형태의 메타 문자열. size가 없으면 시각만.
function formatMeta(e: RecentEntry): string {
  const time = formatRelative(e.ts)
  if (typeof e.size === 'number' && e.size > 0) return `${time} · ${formatSize(e.size)}`
  return time
}

// epoch ms → "방금 전 / n분 전 / n시간 전 / n일 전 / YYYY-MM-DD" 상대 표기.
function formatRelative(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 0) return new Date(ts).toLocaleDateString() // 미래 시각은 날짜로
  const min = Math.floor(diff / 60000)
  if (min < 1) return '방금 전'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}일 전`
  // 일주일이 넘으면 절대 날짜(YYYY-MM-DD)로.
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

// byte → "12KB" / "3.4MB" 등 사람이 읽는 크기.
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)}KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)}MB`
}

// ============================================================
//  공통 스타일 헬퍼(기존 모달과 동일 톤)
// ============================================================

// 주 액션 버튼(강조색 채움) — share-dialog의 '링크 만들기'와 동일 스타일.
function primaryButtonCss(): string {
  return [
    'flex:none',
    'padding:7px 16px',
    'border-radius:8px',
    'border:1px solid var(--rb-accent, #4aa3ff)',
    'background:var(--rb-accent, #4aa3ff)',
    'color:var(--rb-accent-fg, #fff)',
    'cursor:pointer',
    'font:inherit',
    'font-weight:600',
    'white-space:nowrap',
  ].join(';')
}

// 보조 버튼(2차 액션) — settings-panel의 secondaryButtonCss와 동일.
function secondaryButtonCss(): string {
  return [
    'flex:none',
    'padding:7px 14px',
    'border-radius:8px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:transparent',
    'color:var(--rb-text, #e6e6e6)',
    'cursor:pointer',
    'font:inherit',
    'white-space:nowrap',
  ].join(';')
}

// 헤더 우측 아이콘 버튼(닫기 ✕) — settings-panel/share-dialog와 동일.
function iconButtonCss(): string {
  return [
    'flex:none',
    'width:28px',
    'height:28px',
    'border-radius:6px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:transparent',
    'color:var(--rb-text-dim, #777)',
    'cursor:pointer',
    'font:inherit',
  ].join(';')
}
