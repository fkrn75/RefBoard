import { openDialogShell, createDialogButton } from './dialog-shell'

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

export interface ShareDialogResult {
  isPublic: boolean
  expiresAt?: Date
  allowEmails: string[]
}

export function openShareDialog(): Promise<ShareDialogResult | null> {
  return new Promise((resolve) => {
    let confirm = (): void => {}
    openDialogShell<ShareDialogResult | null>({
      title: '웹 링크 공유',
      ariaLabel: '웹 링크 공유',
      cancelValue: null,
      resolve,
      onEnter: () => confirm(),
      render: ({ body, footer, settle, close }) => {
        const publicCheck = document.createElement('input')
        publicCheck.type = 'checkbox'
        // 기본 비공개 — 무심코 '링크 만들기'를 눌러도 공개되지 않게(알파 안전). 공개는 사용자가 의식적으로 체크.
        publicCheck.checked = false
        publicCheck.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:var(--rb-accent, #4aa3ff)'

        const pubLabel = document.createElement('span')
        pubLabel.textContent = '링크가 있는 누구나 보기 (공개)'

        const pubRow = document.createElement('label')
        pubRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer'
        pubRow.append(publicCheck, pubLabel)

        const pubHint = document.createElement('span')
        pubHint.style.cssText = 'font-size:12px;line-height:1.5'
        const pubBox = document.createElement('div')
        pubBox.style.cssText = 'display:flex;flex-direction:column;gap:6px'
        pubBox.append(pubRow, pubHint)

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
        const expLabel = document.createElement('span')
        expLabel.textContent = '만료'
        expLabel.style.cssText = 'flex:none;min-width:64px'
        const expRow = document.createElement('div')
        expRow.style.cssText = 'display:flex;align-items:center;gap:10px'
        expRow.append(expLabel, expirySelect)

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
        const mailLabel = document.createElement('span')
        mailLabel.textContent = '허용 이메일 (쉼표로 구분)'
        const mailHint = document.createElement('span')
        mailHint.textContent = '비우면 나만 볼 수 있어요. 공개를 켜면 무시됩니다.'
        mailHint.style.cssText = 'font-size:12px;color:var(--rb-text-dim, #777)'
        const mailRow = document.createElement('div')
        mailRow.style.cssText = 'display:flex;flex-direction:column;gap:6px'
        mailRow.append(mailLabel, emailInput, mailHint)

        const bodyBox = document.createElement('div')
        bodyBox.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:16px'
        bodyBox.append(pubBox, expRow, mailRow)
        body.appendChild(bodyBox)

        const finish = (result: ShareDialogResult | null): void => {
          settle(result)
          close()
        }
        confirm = (): void => {
          const isPublic = publicCheck.checked
          const days = Number(expirySelect.value) || 0
          const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : undefined
          const allowEmails = isPublic ? [] : emailInput.value.split(',').map((s) => s.trim()).filter(Boolean)
          finish({ isPublic, expiresAt, allowEmails })
        }
        const syncPublic = (): void => {
          const pub = publicCheck.checked
          emailInput.disabled = pub
          mailRow.style.opacity = pub ? '0.45' : '1'
          if (pub) {
            // 공개는 위험 경고 톤 — 링크 유출 시 제3자 접근 가능을 명시(무심코 노출 방지).
            pubHint.textContent =
              '⚠️ 공개: 링크를 받은 누구나 로그인 없이 볼 수 있어요. 링크가 퍼지면 제3자도 접근하니 민감한 보드는 공개하지 마세요.'
            pubHint.style.color = '#e0a33e'
          } else {
            // 비공개(기본)는 중립 안내 — 허용 이메일로 로그인한 사람만 열람.
            pubHint.textContent =
              '🔒 비공개(기본): 아래 허용 이메일로 본인 구글 로그인을 한 사람만 볼 수 있어요. 비우면 나만 볼 수 있습니다.'
            pubHint.style.color = 'var(--rb-text-dim, #888)'
          }
        }
        publicCheck.addEventListener('change', syncPublic)

        const cancelBtn = createDialogButton('취소')
        cancelBtn.addEventListener('click', () => finish(null))
        const okBtn = createDialogButton('링크 만들기')
        okBtn.style.borderColor = 'var(--rb-accent, #4aa3ff)'
        okBtn.style.background = 'var(--rb-accent, #4aa3ff)'
        okBtn.style.color = 'var(--rb-accent-fg, #fff)'
        okBtn.style.fontWeight = '600'
        okBtn.addEventListener('click', confirm)

        footer.append(cancelBtn, okBtn)

        syncPublic()
      },
    })
  })
}
