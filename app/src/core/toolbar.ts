// 데스크탑 UI 셸 — 상단 툴바 + 하단 상태바 (RefBoard Phase 4.4).
//
// 설계 원칙:
//  - PixiJS 캔버스(#app) 위에 얹는 순수 DOM 오버레이. PixiJS·다른 core 모듈에 의존하지 않는다.
//    (색은 theme.ts가 :root에 주입한 --rb-* CSS 변수만 참조 → 테마 전환 시 자동 반영, 하드코딩 금지.)
//  - 버튼은 동작을 직접 알지 않는다. 클릭하면 actionId 문자열을 onAction 콜백으로만 흘려보낸다.
//    actionId는 keymap.ts의 액션 레지스트리와 동일 문자열을 쓰며, main.ts가 onAction→runAction(id)로
//    연결한다(통합은 team-lead). 덕분에 단축키와 버튼이 같은 한 경로(runAction)로 수렴한다.
//  - pointer-events 관리가 핵심: 전체를 덮는 컨테이너는 pointer-events:none이라 캔버스 입력을 통과시키고,
//    바 본체(.rb-toolbar/.rb-statusbar)만 pointer-events:auto로 클릭을 받는다. 바 사이 빈 영역은
//    그대로 캔버스(휠 줌·드래그 팬)로 흘러간다.
//  - 스타일은 1회만 주입하는 <style>(id=rb-toolbar-style)로 관리하고, 모든 색/배경/테두리는 var(--rb-*).

// ---- 타입 ----

// 툴바 버튼 1개 정의. 클릭 시 actionId를 onAction으로 보낸다.
export interface ToolbarButton {
  actionId: string // keymap 액션 id와 동일 문자열(예: 'file.save'). 클릭 시 onAction(actionId) 호출
  title: string // 호버 툴팁(접근성 aria-label 겸용)
  icon: string // 인라인 SVG 마크업 문자열(아래 ICONS 참조). 비우면 title 첫 글자를 텍스트로 표시
  group?: 'file' | 'edit' | 'view' | 'tools' | 'app' // 같은 그룹끼리 묶고 그룹 사이에 구분선을 넣는다
  desktopOnly?: boolean // true면 데스크탑(Tauri)에서만 노출. opts.isDesktop=false면 렌더 생략
}

// 상태바에 표시할 실시간 값. updateStatus로 부분 갱신한다(생략된 필드는 직전 값 유지).
export interface ToolbarStatus {
  zoom: number // 카메라 배율(1 = 100%). %로 환산해 표시
  cursor?: { x: number; y: number } // 커서의 월드좌표. 없으면 '—' 표시(캔버스 밖 등)
  selCount: number // 선택된 항목 개수
  total: number // 보드의 이미지 총 개수
  boardName?: string // 현재 보드 이름(상태바 좌측 표시)
  share?: 'local' | 'public' | 'private' // 공유 상태: 로컬 전용 / 공개 / 비공개
}

// createToolbar 옵션.
export interface ToolbarOptions {
  onAction: (actionId: string) => void // 모든 버튼 클릭의 단일 출구. main.ts에서 runAction(id)로 연결
  actions?: ToolbarButton[] // 버튼 세트 교체(생략 시 DEFAULT_BUTTONS 사용)
  mount?: HTMLElement // 오버레이를 붙일 부모(생략 시 document.body)
  isDesktop?: boolean // 데스크탑 여부. false면 desktopOnly 버튼을 숨긴다(생략 시 true로 간주해 모두 노출)
  onRenameBoard?: () => void // 상태바 보드 이름 클릭 시 호출(이름 변경 트리거). 미지정이면 클릭 비활성.
}

// createToolbar가 돌려주는 핸들. 상태 갱신과 정리(destroy)를 제공한다.
export interface ToolbarHandle {
  updateStatus(s: Partial<ToolbarStatus>): void // 상태바 부분 갱신(생략 필드는 유지)
  setActive(actionId: string, on: boolean): void // 토글성 버튼(항상위 등)의 활성 표시 on/off
  setDisabled(actionId: string, disabled: boolean): void
  destroy(): void // DOM 제거 + 리스너 해제(스타일 태그는 공유 자원이라 남겨둔다)
}

// ---- 인라인 SVG 아이콘 ----
//
// 모두 24x24 viewBox, currentColor 사용(버튼 글자색=var(--rb-text)를 그대로 상속받아 그려짐).
// stroke 기반 라인 아이콘으로 통일해 라이트/다크/글래스 어디서나 또렷하게 보이게 했다.
const SVG_HEAD =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'

const ICONS = {
  // 폴더 열기(보드 열기)
  open: SVG_HEAD + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  // 디스크 저장(보드 저장)
  save:
    SVG_HEAD +
    '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 3v5h7"/><path d="M8 21v-6h8v6"/></svg>',
  // 이미지 가져오기(사진 + 플러스)
  image:
    SVG_HEAD +
    '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="M3 15l4-3 3 2 4-4 7 6"/></svg>',
  // 내보내기(상자에서 위로 나가는 화살표)
  export:
    SVG_HEAD +
    '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
  // 웹 링크 공유(노드 3개 연결 — 표준 share 아이콘)
  share:
    SVG_HEAD +
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  // 테마 전환(반쪽 채운 원 = 명/암)
  theme:
    SVG_HEAD +
    '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/></svg>',
  // 항상 위(압정)
  pin:
    SVG_HEAD +
    '<path d="M15 3l6 6-3 1-3 3-1 5-2-2-4 4-1-1 4-4-2-2 5-1 3-3z"/></svg>',
  // 커맨드 팔레트(검색 돋보기)
  palette:
    SVG_HEAD + '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  // 설정(톱니바퀴 — 단순화한 8각 + 중심원)
  settings:
    SVG_HEAD +
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
  // ---- 도구(tools) 그룹 아이콘 (Phase: 텍스트·드로잉·댓글) ----
  // 선택(화살표 커서) — 기본 도구
  cursor:
    SVG_HEAD + '<path d="M5 3l6 16 2.2-6.2L20 10.6z"/></svg>',
  // 텍스트(대문자 T)
  text:
    SVG_HEAD + '<path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/></svg>',
  // 펜(자유선 — 만년필 촉)
  pen:
    SVG_HEAD + '<path d="M15 4l5 5L9 20l-5 1 1-5z"/><path d="M13 6l5 5"/></svg>',
  // 직선
  line:
    SVG_HEAD + '<path d="M5 19L19 5"/></svg>',
  // 사각형
  rect:
    SVG_HEAD + '<rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
  // 타원
  ellipse:
    SVG_HEAD + '<ellipse cx="12" cy="12" rx="9" ry="6"/></svg>',
  // 화살표(우상향)
  arrow:
    SVG_HEAD + '<path d="M5 19L19 5"/><path d="M10 5h9v9"/></svg>',
  // 지우개
  eraser:
    SVG_HEAD + '<path d="M16 3l5 5L10 19H5l-2-2z"/><path d="M8 21h12"/></svg>',
  // 댓글(말풍선)
  comment:
    SVG_HEAD + '<path d="M4 5h16v11H9l-4 4V5z"/></svg>',
  // 스포이드(색 추출 — 점적기)
  eyedropper:
    SVG_HEAD + '<path d="M18 3l3 3-9 9H9v-3z"/><path d="M9 12l-4 4a2 2 0 0 0 3 3l4-4"/></svg>',
  // 개별 내보내기(여러 장 분리 — 겹친 사각형 + 내보내기 화살표)
  exportEach:
    SVG_HEAD + '<rect x="3" y="7" width="12" height="12" rx="1.5"/><path d="M8 7V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-3"/></svg>',
  // 최근 파일(시계 화살표 — history)
  recent:
    SVG_HEAD + '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>',
  // 내 공유 보드 관리(목록 — 항목 줄들)
  manage:
    SVG_HEAD + '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
} as const

// ---- 기본 버튼 카탈로그 ----
//
// actionId는 keymap.ts의 액션 id와 일치시켰다(파일/팔레트 등). 단 keymap에 대응 액션이 없는
// "테마 전환(app.toggleTheme)"·"설정 열기(app.settings)"는 toolbar가 새로 도입한 앱 레벨 액션 id다.
// (app.settings는 기존 'app.commandPalette' 명사형 네이밍과 결을 맞춘 것 — settings 팀원과 합의.)
// team-lead가 runAction switch에 이 두 case를 추가해 각각 테마 순환·settings-panel의 openSettings()로 배선한다.
const DEFAULT_BUTTONS: ToolbarButton[] = [
  // 파일 그룹
  { actionId: 'file.open', title: '보드 열기 (Ctrl+O)', icon: ICONS.open, group: 'file' },
  { actionId: 'file.save', title: '보드 저장 (Ctrl+S)', icon: ICONS.save, group: 'file' },
  { actionId: 'file.import', title: '이미지 가져오기 (Ctrl+I)', icon: ICONS.image, group: 'file' },
  { actionId: 'file.exportScene', title: '내보내기 (Ctrl+E)', icon: ICONS.export, group: 'file' },
  { actionId: 'file.exportEachAll', title: '개별 내보내기 · 전체 (Ctrl+Alt+I)', icon: ICONS.exportEach, group: 'file' },
  { actionId: 'file.recentOpen', title: '최근 파일 (Ctrl+Alt+L)', icon: ICONS.recent, group: 'file' },
  { actionId: 'share.webLink', title: '웹 뷰어 링크 공유 (Ctrl+Shift+S)', icon: ICONS.share, group: 'file' },
  { actionId: 'share.manage', title: '내 공유 보드 관리', icon: ICONS.manage, group: 'file' },
  // 도구 그룹 — 클릭하면 activeTool을 바꾼다(main.ts runAction에서 set). 활성 도구는 rb-active로 강조.
  { actionId: 'tool.select', title: '선택 도구 (V)', icon: ICONS.cursor, group: 'tools' },
  { actionId: 'tool.text', title: '텍스트 (T)', icon: ICONS.text, group: 'tools' },
  { actionId: 'tool.pen', title: '펜 (P)', icon: ICONS.pen, group: 'tools' },
  { actionId: 'tool.line', title: '직선 (L)', icon: ICONS.line, group: 'tools' },
  { actionId: 'tool.rect', title: '사각형 (R)', icon: ICONS.rect, group: 'tools' },
  { actionId: 'tool.ellipse', title: '타원 (O)', icon: ICONS.ellipse, group: 'tools' },
  { actionId: 'tool.arrow', title: '화살표 (A)', icon: ICONS.arrow, group: 'tools' },
  { actionId: 'tool.eraser', title: '드로잉 지우개 (E)', icon: ICONS.eraser, group: 'tools' },
  { actionId: 'tool.eyedropper', title: '스포이드 · 색 추출 (S)', icon: ICONS.eyedropper, group: 'tools' },
  { actionId: 'comment.edit', title: '선택 이미지에 댓글 (Alt+C)', icon: ICONS.comment, group: 'tools' },
  // 앱/뷰 그룹
  { actionId: 'app.toggleTheme', title: '테마 전환', icon: ICONS.theme, group: 'app' },
  { actionId: 'window.toggleAlwaysOnTop', title: '항상 위에 표시', icon: ICONS.pin, group: 'app', desktopOnly: true },
  { actionId: 'app.commandPalette', title: '커맨드 팔레트 (Ctrl+Shift+P)', icon: ICONS.palette, group: 'app' },
  { actionId: 'app.settings', title: '설정', icon: ICONS.settings, group: 'app' },
]

// ---- 스타일 ----
//
// 한 번만 주입한다(여러 번 createToolbar 해도 1개). 모든 색은 var(--rb-*) — theme.ts가 :root에 주입.
const STYLE_ID = 'rb-toolbar-style'
const STYLE_TEXT = `
.rb-ui-layer {
  position: fixed; inset: 0; z-index: 50;
  pointer-events: none; /* 빈 영역은 캔버스로 입력 통과 */
  font: 13px system-ui, -apple-system, Segoe UI, sans-serif;
  color: var(--rb-text, #e6e6e6);
}
/* 공통 바 외형 */
.rb-toolbar, .rb-statusbar {
  position: absolute; left: 0; right: 0;
  display: flex; align-items: center; box-sizing: border-box;
  pointer-events: auto; /* 바 본체만 클릭/입력 수신 */
  background: var(--rb-panel-bg, #252526);
  border-color: var(--rb-panel-border, #3a3a3a);
  -webkit-user-select: none; user-select: none;
}
.rb-toolbar {
  top: 0; height: 40px; gap: 2px; padding: 0 6px;
  border-bottom: 1px solid var(--rb-panel-border, #3a3a3a);
}
.rb-statusbar {
  bottom: 0; height: 24px; gap: 14px; padding: 0 12px;
  border-top: 1px solid var(--rb-panel-border, #3a3a3a);
  color: var(--rb-text-dim, #888); font-size: 12px;
}
/* 버튼 */
.rb-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; margin: 0;
  border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: inherit; cursor: pointer;
  transition: background-color .12s ease, color .12s ease;
}
.rb-btn:hover { background: color-mix(in srgb, var(--rb-text, #e6e6e6) 14%, transparent); }
.rb-btn:active { transform: translateY(1px); }
.rb-btn:focus-visible { outline: 2px solid var(--rb-accent, #4aa3ff); outline-offset: 1px; }
.rb-btn.rb-active {
  background: var(--rb-accent, #4aa3ff);
  color: var(--rb-accent-fg, #fff);
}
.rb-btn svg { display: block; }
/* 그룹 구분선 */
.rb-sep {
  width: 1px; height: 20px; margin: 0 4px; flex: none;
  background: var(--rb-panel-border, #3a3a3a);
}
.rb-spacer { flex: 1 1 auto; } /* 상태바 항목 사이 밀어내기 */
/* 상태바 항목 */
.rb-stat { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.rb-stat b { color: var(--rb-text, #e6e6e6); font-weight: 600; }
.rb-stat-label { opacity: .8; }
/* 보드 이름(클릭해 변경) + 공유 배지 */
.rb-board-name {
  font: inherit; color: var(--rb-text, #e6e6e6); font-weight: 600;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  padding: 2px 8px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  cursor: pointer;
}
.rb-board-name:hover:not(:disabled) { background: color-mix(in srgb, var(--rb-text, #e6e6e6) 12%, transparent); }
.rb-board-name:disabled { cursor: default; }
.rb-share-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.rb-share-badge[data-share="public"]  { color: #46c98a; border-color: #1f7a4d; background: rgba(31,122,77,.15); }
.rb-share-badge[data-share="private"] { color: #e0a33e; border-color: #7a5a1f; background: rgba(224,163,62,.12); }
.rb-share-badge[data-share="local"]   { color: #999;    border-color: #555;    background: rgba(136,136,136,.12); }
`

// 스타일 1회 주입(중복 방지).
function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = STYLE_TEXT
  document.head.appendChild(el)
}

// 숫자 포맷 헬퍼: 월드좌표는 정수 반올림, 줌은 % 정수.
function fmtCoord(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : '—'
}
function fmtZoom(z: number): string {
  return (Number.isFinite(z) ? Math.round(z * 100) : 100) + '%'
}

export function formatToolbarCursor(cursor: ToolbarStatus['cursor']): string {
  return cursor ? `${fmtCoord(cursor.x)}, ${fmtCoord(cursor.y)}` : '—'
}

// ---- 공개 API ----

// 툴바 + 상태바를 생성해 mount(기본 document.body) 위에 얹고, 제어 핸들을 반환한다.
export function createToolbar(opts: ToolbarOptions): ToolbarHandle {
  ensureStyle()

  const doc = document
  const root = opts.mount ?? doc.body
  const isDesktop = opts.isDesktop !== false // 미지정 시 true(모든 버튼 노출)
  const buttons = (opts.actions ?? DEFAULT_BUTTONS).filter((b) => isDesktop || !b.desktopOnly)

  // 전체 오버레이 레이어(pointer-events:none) — 바만 그 위에서 입력을 받는다.
  const layer = doc.createElement('div')
  layer.className = 'rb-ui-layer'

  // ---- 상단 툴바 ----
  const toolbar = doc.createElement('div')
  toolbar.className = 'rb-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', 'RefBoard 도구막대')

  // actionId → 버튼 엘리먼트(setActive로 활성 토글할 때 조회).
  const btnByAction = new Map<string, HTMLButtonElement>()
  let prevGroup: string | undefined

  for (const def of buttons) {
    // 그룹이 바뀌면 구분선 삽입(첫 그룹 앞에는 넣지 않음).
    if (prevGroup !== undefined && def.group !== prevGroup) {
      const sep = doc.createElement('div')
      sep.className = 'rb-sep'
      toolbar.appendChild(sep)
    }
    prevGroup = def.group

    const btn = doc.createElement('button')
    btn.className = 'rb-btn'
    btn.type = 'button'
    btn.title = def.title
    btn.setAttribute('aria-label', def.title)
    btn.dataset.action = def.actionId
    // 아이콘이 있으면 SVG, 없으면 title 첫 글자(폴백).
    btn.innerHTML = def.icon || `<span>${def.title.charAt(0)}</span>`
    // 같은 actionId가 마지막에 등록된 버튼이 setActive 대상이 된다(보통 1:1).
    btnByAction.set(def.actionId, btn)
    toolbar.appendChild(btn)
  }

  // 이벤트 위임: 어떤 버튼을 눌러도 한 핸들러에서 actionId를 뽑아 onAction으로 보낸다.
  function onToolbarClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button.rb-btn')
    if (!target) return
    const id = target.dataset.action
    if (id) opts.onAction(id)
  }
  toolbar.addEventListener('click', onToolbarClick)

  // ---- 하단 상태바 ----
  const statusbar = doc.createElement('div')
  statusbar.className = 'rb-statusbar'
  statusbar.setAttribute('role', 'status')
  statusbar.setAttribute('aria-live', 'off') // 좌표가 매 프레임 바뀌므로 스크린리더 낭독은 끈다

  // 각 통계 칸을 만들고 값 노드(<b>)만 따로 들고 있다가 갱신한다(전체 재렌더 없이 textContent만 교체).
  function makeStat(label: string): { wrap: HTMLElement; val: HTMLElement } {
    const wrap = doc.createElement('span')
    wrap.className = 'rb-stat'
    const lab = doc.createElement('span')
    lab.className = 'rb-stat-label'
    lab.textContent = label
    const val = doc.createElement('b')
    wrap.appendChild(lab)
    wrap.appendChild(val)
    return { wrap, val }
  }

  const zoomStat = makeStat('줌')
  const cursorStat = makeStat('커서')
  const selStat = makeStat('선택')
  const totalStat = makeStat('이미지')

  // 보드 이름(클릭해 변경) + 공유 배지 — 상태바 맨 왼쪽.
  const boardNameEl = doc.createElement('button')
  boardNameEl.className = 'rb-board-name'
  boardNameEl.type = 'button'
  if (opts.onRenameBoard) {
    boardNameEl.title = '클릭해 보드 이름 변경'
    boardNameEl.addEventListener('click', () => opts.onRenameBoard?.())
  } else {
    boardNameEl.disabled = true
  }
  const shareBadge = doc.createElement('span')
  shareBadge.className = 'rb-share-badge'

  statusbar.appendChild(boardNameEl)
  statusbar.appendChild(shareBadge)
  statusbar.appendChild(zoomStat.wrap)
  const spacer = doc.createElement('div')
  spacer.className = 'rb-spacer'
  statusbar.appendChild(spacer)
  statusbar.appendChild(cursorStat.wrap)
  statusbar.appendChild(selStat.wrap)
  statusbar.appendChild(totalStat.wrap)

  layer.appendChild(toolbar)
  layer.appendChild(statusbar)
  root.appendChild(layer)

  // 직전 상태를 보관해 부분 갱신(생략 필드 유지)을 지원한다.
  const state: ToolbarStatus = { zoom: 1, selCount: 0, total: 0, boardName: '', share: 'local' }

  // 보관 상태를 DOM에 반영.
  function render(): void {
    boardNameEl.textContent = state.boardName || '제목 없음'
    const sh = state.share ?? 'local'
    shareBadge.textContent = sh === 'public' ? '공개' : sh === 'private' ? '비공개' : '로컬'
    shareBadge.dataset.share = sh
    zoomStat.val.textContent = fmtZoom(state.zoom)
    cursorStat.val.textContent = formatToolbarCursor(state.cursor)
    selStat.val.textContent = String(state.selCount)
    totalStat.val.textContent = String(state.total)
  }
  render() // 초기값 그리기

  // ---- 핸들 ----
  return {
    updateStatus(s: Partial<ToolbarStatus>): void {
      if (typeof s.zoom === 'number') state.zoom = s.zoom
      if (typeof s.selCount === 'number') state.selCount = s.selCount
      if (typeof s.total === 'number') state.total = s.total
      if (typeof s.boardName === 'string') state.boardName = s.boardName
      if (s.share) state.share = s.share
      // cursor는 명시적으로 키가 들어왔을 때만 갱신(undefined를 넘기면 '캔버스 밖'으로 해석해 지움).
      if ('cursor' in s) state.cursor = s.cursor
      render()
    },
    setActive(actionId: string, on: boolean): void {
      btnByAction.get(actionId)?.classList.toggle('rb-active', on)
    },
    setDisabled(actionId: string, disabled: boolean): void {
      const button = btnByAction.get(actionId)
      if (button) button.disabled = disabled
    },
    destroy(): void {
      toolbar.removeEventListener('click', onToolbarClick)
      layer.remove()
      btnByAction.clear()
      // 공유 <style>(STYLE_ID)는 다른 인스턴스가 쓸 수 있으므로 남겨둔다.
    },
  }
}
