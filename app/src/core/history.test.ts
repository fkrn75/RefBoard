import { describe, expect, it } from 'vitest'
import { isImageItem, type BoardState } from './board'
import { cloneBoardForHistory } from './history'

const dataUrl = 'data:image/png;base64,' + 'a'.repeat(128)

function boardWithImage(): BoardState {
  return {
    schema: 'refboard/1.0',
    board: { id: 'board-1', title: 'History', canvas: { bg: '#111' }, shareId: 'share-1', sharePublic: true },
    camera: { x: 1, y: 2, zoom: 3 },
    items: [
      {
        id: 'image-1',
        type: 'image',
        src: dataUrl,
        srcs: { thumb: dataUrl, medium: dataUrl, orig: dataUrl },
        natural: { w: 100, h: 80 },
        crop: { x: 1, y: 2, w: 30, h: 40 },
        transform: { x: 10, y: 20, scale: 2, rotation: 0.5, flipX: true },
        opacity: 0.8,
        locked: false,
        groupId: 'group-1',
        z: 1,
        comment: 'memo',
        name: 'sample.png',
        addedAt: 123,
      },
    ],
  }
}

describe('cloneBoardForHistory', () => {
  it('copies mutable board metadata while preserving immutable image payload values', () => {
    // Given
    const source = boardWithImage()

    // When
    const clone = cloneBoardForHistory(source)

    // Then
    expect(clone).toEqual(source)
    expect(clone).not.toBe(source)
    expect(clone.items).not.toBe(source.items)
    expect(clone.items[0]).not.toBe(source.items[0])
    const clonedItem = clone.items[0]
    const sourceItem = source.items[0]
    expect(clonedItem && isImageItem(clonedItem) ? clonedItem.src : '').toBe(
      sourceItem && isImageItem(sourceItem) ? sourceItem.src : '',
    )
  })
})
