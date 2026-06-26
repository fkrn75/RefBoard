// 공유 다이얼로그 — 웹 뷰어 링크 공유 시 "공개 여부 · 만료 · 허용 이메일"을 한 모달에서 입력받는다(M5).
//
// 기존 prompt() 한 줄(이메일만)을 대체한다. settings-panel.ts의 모달 패턴(백드롭+패널, 캡처단계
// 키 처리, Esc/바깥클릭 닫기, theme.ts의 --rb-* 변수 직접 참조)을 그대로 따른다.
// 이 모듈은 "입력 수집"만 담당한다 — 실제 업로드는 호출측(main.ts shareWebLink)이 반환값을
// supabase-share의 upload(board, opts)에 넘겨 수행한다(책임 분리).
//
// 반환: 확인 시 { isPublic, expiresAt?, allowEmails }, 취소(Esc/바깥클릭/취소·닫기 버튼) 시 null.

// 만료 프리셋(라벨 → 일수. 0 = 만료 없음).
interface ExpiryOption {
  label: string
  days: number
}
const EXPIRY_OPTIONS: ExpiryOption[] = [
  { label: '없음 (무기한)', days: 0 },
  { label: '1일 후', days: 1 },
  { label: '7일 후', days: 7 },
  { label: '30일 후', days: 30 },
]

// upload()의 UploadOptions와 호환되는 입력 결과(공개/만료/허용목록).
export interface ShareDialogResult {
  isPublic: boolean
  expiresAt?: Date
  allowEmails: string[]
}

// 동시에 하나만 — 이미 떠 있으면 즉시 취소(null)로 응답해 중복 모달을 막는다.
let openRoot: HTMLDivElement | null = null

// 공유 옵션 모달을 열고, 사용자의 확인/취소를 Promise로 돌려준다.
export function openShareDialog(): Promise<ShareDialogResult | null> {
  return new Promise((resolve) => {
    if (openRoot) {
      resolve(null)
      return
    }

    // 1회 resolve 보장 플래그 + 정리에 쓸 전역 keydown 핸들러 참조.
    let settled = false
    let onDocKeydown: ((e: KeyboardEvent) => void) | null = null

    // ---- 백드롭(화면 전체 딤) ----
    const backdrop = document.createElement('div')
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-modal', 'true')
    backdrop.setAttribute('aria-label', '웹 링크 공유')
    backdrop.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:10000',
      'display:flex',
      'justify-content:center',
      'align-items:flex-start',
      'padding-top:12vh',
      'background:var(--rb-backdrop, rgba(0,0,0,.45))',
      'font:14px system-ui,Segoe UI,sans-serif',
    ].join(';')

    // ---- 패널 ----
    const panel = document.createElement('div')
    panel.style.cssText = [
      'width:min(440px,94vw)',
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
    ].join(';')
    const title = document.createElement('strong')
    title.textContent = '웹 링크 공유'
    title.style.cssText = 'font-size:14px;flex:1 1 auto'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.textContent = '✕'
    closeBtn.setAttribute('aria-label', '닫기')
    closeBtn.style.cssText = [
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
    header.appendChild(title)
    header.appendChild(closeBtn)

    // ---- 본문(공개 토글 / 만료 / 이메일) ----
    const body = document.createElement('div')
    body.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:16px'

    // 1) 공개 토글.
    const pubRow = document.createElement('label')
    pubRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer'
    const publicCheck = document.createElement('input')
    publicCheck.type = 'checkbox'
    publicCheck.checked = true // 기본 공개 — 혼자 PC↔폰으로 보는 흔한 용도에서 매번 켜는 수고·실수를 없앤다.
    publicCheck.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--rb-accent, #4aa3ff)'
    const pubLabel = document.createElement('span')
    pubLabel.textContent = '링크가 있는 누구나 보기 (공개)'
    pubRow.appendChild(publicCheck)
    pubRow.appendChild(pubLabel)

    // 공개/비공개에 따른 안내·경고(폰·다른 기기에서 열람 가능한지 명확히). 내용은 syncPublic이 채운다.
    const pubHint = document.createElement('span')
    pubHint.style.cssText = 'font-size:12px;line-height:1.5'
    // 공개 토글 + 안내문을 한 컬럼으로 묶는다(아래 '허용 이메일' 행의 label+input+hint 패턴과 일관).
    const pubBox = document.createElement('div')
    pubBox.style.cssText = 'display:flex;flex-direction:column;gap:6px'
    pubBox.appendChild(pubRow)
    pubBox.appendChild(pubHint)

    // 2) 만료 선택.
    const expRow = document.createElement('div')
    expRow.style.cssText = 'display:flex;align-items:center;gap:10px'
    const expLabel = document.createElement('span')
    expLabel.textContent = '만료'
    expLabel.style.cssText = 'flex:none;min-width:64px'
    const expirySelect = document.createElement('select')
    expirySelect.setAttribute('aria-label', '링크 만료')
    expirySelect.style.cssText = [
      'flex:1 1 auto',
      'padding:7px 10px',
      'border-radius:8px',
      'border:1px solid var(--rb-panel-border, #3a3a3a)',
      'background:var(--rb-panel-bg, #252526)',
      'color:var(--rb-text, #e6e6e6)',
      'font:inherit',
      'cursor:pointer',
    ].join(';')
    for (const opt of EXPIRY_OPTIONS) {
      const o = document.createElement('option')
      o.value = String(opt.days)
      o.textContent = opt.label
      expirySelect.appendChild(o)
    }
    expRow.appendChild(expLabel)
    expRow.appendChild(expirySelect)

    // 3) 허용 이메일(쉼표 구분). 공개를 켜면 비활성.
    const mailRow = document.createElement('div')
    mailRow.style.cssText = 'display:flex;flex-direction:column;gap:6px'
    const mailLabel = document.createElement('span')
    mailLabel.textContent = '허용 이메일 (쉼표로 구분)'
    const emailInput = document.createElement('input')
    emailInput.type = 'text'
    emailInput.spellcheck = false
    emailInput.placeholder = 'alice@example.com, bob@example.com'
    emailInput.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'padding:8px 10px',
      'border-radius:8px',
      'border:1px solid var(--rb-panel-border, #3a3a3a)',
      'background:var(--rb-app-bg, #1e1e1e)',
      'color:var(--rb-text, #e6e6e6)',
      'font:inherit',
    ].join(';')
    const mailHint = document.createElement('span')
    mailHint.textContent = '비우면 나만 볼 수 있어요. 공개를 켜면 무시됩니다.'
    mailHint.style.cssText = 'font-size:12px;color:var(--rb-text-dim, #777)'
    mailRow.appendChild(mailLabel)
    mailRow.appendChild(emailInput)
    mailRow.appendChild(mailHint)

    body.appendChild(pubBox)
    body.appendChild(expRow)
    body.appendChild(mailRow)

    // ---- 푸터(취소 / 링크 만들기) ----
    const footer = document.createElement('div')
    footer.style.cssText = [
      'display:flex',
      'justify-content:flex-end',
      'gap:8px',
      'padding:12px 14px',
      'border-top:1px solid var(--rb-panel-border, #3a3a3a)',
    ].join(';')
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = '취소'
    cancelBtn.style.cssText = [
      'flex:none',
      'padding:7px 14px',
      'border-radius:8px',
      'border:1px solid var(--rb-panel-border, #3a3a3a)',
      'background:transparent',
      'color:var(--rb-text, #e6e6e6)',
      'cursor:pointer',
      'font:inherit',
    ].join(';')
    const okBtn = document.createElement('button')
    okBtn.type = 'button'
    okBtn.textContent = '링크 만들기'
    okBtn.style.cssText = [
      'flex:none',
      'padding:7px 16px',
      'border-radius:8px',
      'border:1px solid var(--rb-accent, #4aa3ff)',
      'background:var(--rb-accent, #4aa3ff)',
      'color:var(--rb-accent-fg, #fff)',
      'cursor:pointer',
      'font:inherit',
      'font-weight:600',
    ].join(';')
    footer.appendChild(cancelBtn)
    footer.appendChild(okBtn)

    // ---- 조립 ----
    panel.appendChild(header)
    panel.appendChild(body)
    panel.appendChild(footer)
    backdrop.appendChild(panel)

    // ---- 동작 ----
    // 정리 + 1회 resolve. 이후 모든 닫기 경로(확인/취소/Esc/바깥클릭)는 이 함수로 모인다.
    const finish = (result: ShareDialogResult | null): void => {
      if (settled) return
      settled = true
      if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown, true)
      backdrop.remove()
      openRoot = null
      resolve(result)
    }
    // 확인: 입력값을 UploadOptions 형태로 모아 resolve.
    const confirmAndClose = (): void => {
      const isPublic = publicCheck.checked
      const days = Number(expirySelect.value) || 0
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : undefined
      // 공개면 허용목록은 의미 없으므로 빈 배열. 아니면 쉼표 분해(기존 prompt 파싱과 동일).
      const allowEmails = isPublic
        ? []
        : emailInput.value.split(',').map((s) => s.trim()).filter(Boolean)
      finish({ isPublic, expiresAt, allowEmails })
    }

    // 공개 토글 시 이메일 입력을 비활성·흐리게(공개는 허용목록을 무시하므로) + 안내/경고문 갱신.
    const syncPublic = (): void => {
      const pub = publicCheck.checked
      emailInput.disabled = pub
      mailRow.style.opacity = pub ? '0.45' : '1'
      // 공개=로그인 없이 누구나 열림 / 비공개=외부·폰에서 안 보일 수 있음(본인 로그인 필요) 경고.
      if (pub) {
        pubHint.textContent = '✓ 링크가 있으면 누구나 로그인 없이 볼 수 있어요 — 폰·다른 기기에서 바로 열립니다.'
        pubHint.style.color = 'var(--rb-text-dim, #888)'
      } else {
        pubHint.textContent =
          '⚠️ 비공개: 받는 사람도 본인 구글 로그인이 필요해요. 폰·다른 기기에선 안 보일 수 있습니다.'
        pubHint.style.color = '#e0a33e'
      }
    }
    publicCheck.addEventListener('change', syncPublic)

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(null) // 바깥 클릭 = 취소
    })
    closeBtn.addEventListener('click', () => finish(null))
    cancelBtn.addEventListener('click', () => finish(null))
    okBtn.addEventListener('click', () => confirmAndClose())

    // 키 입력은 캡처 단계에서 처리해 캔버스 단축키(Ctrl+Shift+S 등)와 충돌하지 않게 한다.
    // (settings-panel.ts와 동일 패턴 — 모달이 떠 있는 동안 전역 단축키 전파를 막는다.)
    onDocKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        confirmAndClose()
        return
      }
      // 그 외 키는 폼 입력이 정상 동작하도록 두되, 전역 단축키로 전파만 차단.
      e.stopPropagation()
    }
    document.addEventListener('keydown', onDocKeydown, true)

    // ---- 표시 ----
    document.body.appendChild(backdrop)
    openRoot = backdrop
    syncPublic()
    emailInput.focus()
  })
}
