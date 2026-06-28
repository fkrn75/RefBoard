import { MODAL_Z_INDEX } from './constants'
import { createFocusTrap, type FocusTrap } from './modal'

let openRoot: HTMLDivElement | null = null

export function openDialogShell<T>(options: {
  title: string
  ariaLabel: string
  render: (ctx: { body: HTMLDivElement; footer: HTMLDivElement; settle(value: T): void; close(): void }) => void
  resolve: (value: T) => void
  cancelValue: T
  onEnter?: () => void
}): void {
  if (openRoot) {
    options.resolve(options.cancelValue)
    return
  }

  let settled = false
  let onDocKeydown: ((e: KeyboardEvent) => void) | null = null
  let focusTrap: FocusTrap | null = null

  const backdrop = document.createElement('div')
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', options.ariaLabel)
  backdrop.style.cssText = [
    'position:fixed',
    'inset:0',
    `z-index:${MODAL_Z_INDEX}`,
    'display:flex',
    'justify-content:center',
    'align-items:flex-start',
    'padding-top:12vh',
    'background:var(--rb-backdrop, rgba(0,0,0,.45))',
    'font:14px system-ui,Segoe UI,sans-serif',
  ].join(';')

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
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
  ].join(';')
  panel.addEventListener('mousedown', (e) => e.stopPropagation())

  const header = document.createElement('div')
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'gap:8px',
    'padding:12px 14px',
    'border-bottom:1px solid var(--rb-panel-border, #3a3a3a)',
  ].join(';')
  const title = document.createElement('strong')
  title.textContent = options.title
  title.style.cssText = 'font-size:14px;flex:1 1 auto'
  const closeBtn = createDialogButton('✕')
  closeBtn.setAttribute('aria-label', '닫기')
  closeBtn.style.width = '28px'
  closeBtn.style.padding = '0'
  closeBtn.style.height = '28px'
  closeBtn.style.flex = 'none'
  header.append(title, closeBtn)

  const body = document.createElement('div')
  body.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:14px'
  const footer = document.createElement('div')
  footer.style.cssText = [
    'display:flex',
    'justify-content:flex-end',
    'gap:8px',
    'padding:12px 14px',
    'border-top:1px solid var(--rb-panel-border, #3a3a3a)',
  ].join(';')

  panel.append(header, body, footer)
  backdrop.appendChild(panel)
  focusTrap = createFocusTrap(backdrop)

  const settle = (value: T): void => {
    if (settled) return
    settled = true
    if (onDocKeydown) document.removeEventListener('keydown', onDocKeydown, true)
    focusTrap?.dispose()
    backdrop.remove()
    openRoot = null
    options.resolve(value)
  }
  const close = (): void => {
    settle(options.cancelValue)
  }

  onDocKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'Enter' && options.onEnter && !(e.target instanceof HTMLTextAreaElement) && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      options.onEnter()
      return
    }
    if (e.key === 'Tab') {
      e.stopPropagation()
      focusTrap?.handleKeydown(e)
      return
    }
    e.stopPropagation()
  }

  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })

  options.render({ body, footer, settle, close })
  document.addEventListener('keydown', onDocKeydown, true)
  document.body.appendChild(backdrop)
  openRoot = backdrop
  focusTrap.activate()
}

export function createDialogButton(label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.textContent = label
  b.style.cssText = [
    'flex:none',
    'padding:7px 14px',
    'border-radius:8px',
    'border:1px solid var(--rb-panel-border, #3a3a3a)',
    'background:transparent',
    'color:var(--rb-text, #e6e6e6)',
    'cursor:pointer',
    'font:inherit',
  ].join(';')
  return b
}
