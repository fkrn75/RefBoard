import { describe, expect, it } from 'vitest'
import { buildA11yImageLabel, buildCommentBadgeAnchors, hasComment } from './comment-utils'
import type { BoardImage, BoardItem, BoardNote } from '../core/board'

function makeImage(overrides: Partial<BoardImage> = {}): BoardImage {
  return {
    id: 'img-1',
    type: 'image',
    src: 'data:image/png;base64,AAAA',
    natural: { w: 100, h: 100 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    locked: false,
    z: 0,
    ...overrides,
  }
}

function makeNote(overrides: Partial<BoardNote> = {}): BoardNote {
  return {
    id: 'note-1',
    type: 'note',
    text: 'hello',
    fontSize: 16,
    color: '#000000',
    natural: { w: 100, h: 40 },
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    locked: false,
    z: 0,
    ...overrides,
  }
}

describe('hasComment', () => {
  it('댓글 텍스트가 있는 이미지는 true', () => {
    expect(hasComment(makeImage({ comment: '좋은 참고 이미지' }))).toBe(true)
  })

  it('공백만 있는 댓글은 false(main.ts commentAt과 동일 규칙)', () => {
    expect(hasComment(makeImage({ comment: '   ' }))).toBe(false)
  })

  it('comment 필드 자체가 없으면 false', () => {
    expect(hasComment(makeImage())).toBe(false)
  })

  it('이미지가 아닌 아이템(노트)은 댓글 필드가 없으므로 false', () => {
    expect(hasComment(makeNote() as BoardItem)).toBe(false)
  })
})

describe('buildCommentBadgeAnchors', () => {
  const aabb = { minX: 10, minY: 20, maxX: 110, maxY: 220 }

  it('댓글 있는 이미지만 우상단 코너를 앵커로 반환한다', () => {
    const items: BoardItem[] = [
      makeImage({ id: 'a', comment: '메모A' }),
      makeImage({ id: 'b' }), // 댓글 없음 → 제외
      makeNote({ id: 'c' }) as BoardItem, // 이미지 아님 → 제외
    ]
    const anchors = buildCommentBadgeAnchors(items, () => aabb)
    expect(anchors).toEqual([{ id: 'a', comment: '메모A', worldX: 110, worldY: 20 }])
  })

  it('AABB를 못 구하는(null) 아이템은 조용히 건너뛴다', () => {
    const items: BoardItem[] = [makeImage({ id: 'a', comment: '메모A' })]
    const anchors = buildCommentBadgeAnchors(items, () => null)
    expect(anchors).toEqual([])
  })
})

describe('buildA11yImageLabel', () => {
  it('댓글이 없으면 기본 라벨만', () => {
    expect(buildA11yImageLabel(0, 3, null)).toBe('이미지 1 크게 보기 (총 3개)')
  })

  it('댓글이 있으면 라벨 뒤에 붙인다', () => {
    expect(buildA11yImageLabel(1, 3, '참고용')).toBe('이미지 2 크게 보기 (총 3개) · 댓글: 참고용')
  })
})
