import { createDialogButton, openDialogShell } from './dialog-shell'

export interface PromptDialogOptions {
  title: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  multiline?: boolean
}

export interface ConfirmDialogOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

export function openPromptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    openDialogShell<string | null>({
      title: options.title,
      ariaLabel: options.title,
      cancelValue: null,
      render: ({ body, footer, settle, close }) => {
        const form = document.createElement('form')
        form.style.cssText = 'display:flex;flex-direction:column;gap:14px'

        const label = document.createElement('label')
        label.textContent = options.label
        label.style.cssText = 'display:flex;flex-direction:column;gap:6px;line-height:1.4'

        const field = options.multiline ? document.createElement('textarea') : document.createElement('input')
        if (field instanceof HTMLInputElement) field.type = 'text'
        field.value = options.initialValue ?? ''
        if (options.placeholder) field.placeholder = options.placeholder
        field.style.cssText = [
          'width:100%',
          'box-sizing:border-box',
          'padding:8px 10px',
          'border-radius:8px',
          'border:1px solid var(--rb-panel-border, #3a3a3a)',
          'background:var(--rb-app-bg, #1e1e1e)',
          'color:var(--rb-text, #e6e6e6)',
          'font:inherit',
          'resize:vertical',
          options.multiline ? 'min-height:110px' : '',
        ]
          .filter(Boolean)
          .join(';')

        if (!options.multiline) {
          field.addEventListener('keydown', (e) => {
            if (!(e instanceof KeyboardEvent)) return
            if (e.key === 'Enter') {
              e.preventDefault()
              form.requestSubmit()
            }
          })
        }
        if (options.multiline) {
          field.addEventListener('keydown', (e) => {
            if (!(e instanceof KeyboardEvent)) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              form.requestSubmit()
            }
          })
        }

        label.append(field)
        body.append(label)

        const cancelBtn = createDialogButton(options.cancelLabel ?? '취소')
        cancelBtn.type = 'button'
        cancelBtn.addEventListener('click', close)

        const okBtn = createDialogButton(options.confirmLabel ?? '확인')
        okBtn.type = 'submit'
        okBtn.style.background = 'var(--rb-accent, #4aa3ff)'
        okBtn.style.color = 'var(--rb-accent-fg, #fff)'
        okBtn.style.borderColor = 'transparent'

        form.addEventListener('submit', (e) => {
          e.preventDefault()
          settle(field.value)
        })

        form.append(cancelBtn, okBtn)
        footer.append(form)
        queueMicrotask(() => field.focus())
        if (!options.multiline && field instanceof HTMLInputElement) queueMicrotask(() => field.select())
      },
      resolve,
    })
  })
}

export function openConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    openDialogShell<boolean>({
      title: options.title,
      ariaLabel: options.title,
      cancelValue: false,
      render: ({ body, footer, settle, close }) => {
        const msg = document.createElement('p')
        msg.textContent = options.message
        msg.style.cssText = 'margin:0;white-space:pre-wrap;line-height:1.5'
        body.append(msg)

        const cancelBtn = createDialogButton(options.cancelLabel ?? '취소')
        cancelBtn.type = 'button'
        cancelBtn.addEventListener('click', close)

        const okBtn = createDialogButton(options.confirmLabel ?? '확인')
        okBtn.type = 'submit'
        if (options.destructive) {
          okBtn.style.background = 'var(--rb-warn, #e06c6c)'
          okBtn.style.color = '#fff'
          okBtn.style.borderColor = 'transparent'
        }

        const form = document.createElement('form')
        form.style.cssText = 'display:flex;justify-content:flex-end;gap:8px'
        form.addEventListener('submit', (e) => {
          e.preventDefault()
          settle(true)
        })
        form.append(cancelBtn, okBtn)
        footer.append(form)
      },
      resolve,
    })
  })
}
