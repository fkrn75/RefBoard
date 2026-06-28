import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openConfirmDialog, openPromptDialog } from './dialog'
import { openDialogShell } from './dialog-shell'

const originalRaf = globalThis.requestAnimationFrame
const originalCancelRaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  document.body.innerHTML = ''
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  globalThis.requestAnimationFrame = originalRaf
  globalThis.cancelAnimationFrame = originalCancelRaf
})

describe('openPromptDialog', () => {
  it('returns the entered text when the prompt is confirmed', async () => {
    const prompt = openPromptDialog({
      title: '보드 이름 변경',
      label: '보드 이름',
      initialValue: '기존',
      confirmLabel: '저장',
    })

    const input = document.querySelector('input')
    expect(input).not.toBeNull()
    if (!input) return
    input.value = '새 이름'

    const okButton = findButton('저장')
    expect(okButton).not.toBeNull()
    okButton?.click()

    await expect(prompt).resolves.toBe('새 이름')
  })

  it('ignores Enter while the input method is composing', async () => {
    const requestSubmitSpy = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit')
    const prompt = openPromptDialog({
      title: 'Compose',
      label: 'Compose',
      initialValue: 'keep',
      confirmLabel: 'Confirm',
    })

    const input = document.querySelector('input')
    expect(input).not.toBeNull()
    if (!input) return

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(event, 'isComposing', { value: true })
    input.dispatchEvent(event)

    expect(requestSubmitSpy).not.toHaveBeenCalled()
    findButton('Confirm')?.click()

    await expect(prompt).resolves.toBe('keep')
  })

  it('uses a textarea and keeps line breaks for multiline prompts', async () => {
    const prompt = openPromptDialog({
      title: '이미지 댓글 편집',
      label: '이미지 댓글',
      initialValue: '첫 줄',
      confirmLabel: '저장',
      multiline: true,
    })

    const textarea = document.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    textarea.value = '첫 줄\n둘째 줄'

    const okButton = findButton('저장')
    expect(okButton).not.toBeNull()
    okButton?.click()

    await expect(prompt).resolves.toBe('첫 줄\n둘째 줄')
  })

  it('returns null when canceled', async () => {
    const prompt = openPromptDialog({
      title: '보드 이름 변경',
      label: '보드 이름',
      initialValue: '기존',
    })

    findButton('취소')?.click()

    await expect(prompt).resolves.toBeNull()
  })
})

describe('openConfirmDialog', () => {
  it('returns true when confirmed and false when canceled', async () => {
    const confirmed = openConfirmDialog({
      title: '보드 열기',
      message: '계속할까요?',
      confirmLabel: '불러오기',
    })
    findButton('불러오기')?.click()
    await expect(confirmed).resolves.toBe(true)

    const canceled = openConfirmDialog({
      title: '보드 열기',
      message: '계속할까요?',
      confirmLabel: '불러오기',
    })
    findButton('취소')?.click()
    await expect(canceled).resolves.toBe(false)
  })
})

describe('openDialogShell', () => {
  it('submits the primary action on Enter when enabled', async () => {
    let triggerPrimary = () => {}
    const result = new Promise<string | null>((resolve) => {
      openDialogShell<string | null>({
        title: '공유',
        ariaLabel: '공유',
        cancelValue: null,
        onEnter: () => triggerPrimary(),
        resolve,
        render: ({ body, settle }) => {
          triggerPrimary = () => settle('ok')
          const input = document.createElement('input')
          input.type = 'text'
          body.appendChild(input)
        },
      })
    })

    const input = document.querySelector('input')
    expect(input).not.toBeNull()
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await expect(result).resolves.toBe('ok')
  })
})

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find(
    (button): button is HTMLButtonElement => button.textContent === label,
  ) ?? null
}
