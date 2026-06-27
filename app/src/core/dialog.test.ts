import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openConfirmDialog, openPromptDialog } from './dialog'

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

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find(
    (button): button is HTMLButtonElement => button.textContent === label,
  ) ?? null
}
