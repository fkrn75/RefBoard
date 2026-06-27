import { describe, expect, it } from 'vitest'
import { createEmptyBoard, deserialize, parseBoardState, serialize, type BoardState } from './board'

const mixedBoard: BoardState = {
  schema: 'refboard/1.0',
  board: { id: 'board-1', title: '회귀 테스트', canvas: { bg: '#101010' }, shareId: 'share-1', sharePublic: true },
  camera: { x: 10, y: -20, zoom: 1.5 },
  items: [
    {
      id: 'image-1',
      type: 'image',
      src: 'data:image/png;base64,iVBORw0KGgo=',
      srcs: { thumb: 'thumb', medium: 'medium', orig: 'orig' },
      natural: { w: 640, h: 480 },
      transform: { x: 1, y: 2, scale: 0.5, rotation: 0.25, flipX: true },
      crop: { x: 10, y: 20, w: 300, h: 200 },
      opacity: 0.75,
      locked: false,
      groupId: 'group-1',
      z: 3,
      comment: '메모',
      name: 'sample.png',
      addedAt: 1234,
    },
    {
      id: 'note-1',
      type: 'note',
      text: '노트',
      fontSize: 18,
      color: '#ffffff',
      natural: { w: 120, h: 40 },
      transform: { x: 3, y: 4, scale: 1, rotation: 0 },
      opacity: 1,
      locked: true,
      z: 4,
    },
    {
      id: 'drawing-1',
      type: 'drawing',
      tool: 'arrow',
      points: [{ x: 0, y: 0 }, { x: 100, y: 20 }],
      color: '#ff0000',
      width: 3,
      natural: { w: 100, h: 20 },
      transform: { x: 5, y: 6, scale: 2, rotation: 0.5 },
      opacity: 0.8,
      locked: false,
      z: 5,
    },
  ],
}

describe('deserialize', () => {
  it('round-trips an empty board when serialized board JSON is loaded', () => {
    const board = createEmptyBoard()

    const restored = deserialize(serialize(board))

    expect(restored).toEqual(board)
  })

  it('preserves mixed item fields when image, note, and drawing items are serialized', () => {
    const restored = deserialize(serialize(mixedBoard))

    expect(restored).toEqual(mixedBoard)
  })

  it('accepts legacy image items when optional fields are absent', () => {
    const legacyBoard: BoardState = {
      schema: 'refboard/1.0',
      board: { id: 'legacy', title: '구버전', canvas: { bg: '#000000' } },
      camera: { x: 0, y: 0, zoom: 1 },
      items: [
        {
          id: 'image-legacy',
          type: 'image',
          src: 'data:image/png;base64,iVBORw0KGgo=',
          natural: { w: 10, h: 20 },
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          opacity: 1,
          locked: false,
          z: 0,
        },
      ],
    }

    expect(deserialize(serialize(legacyBoard))).toEqual(legacyBoard)
  })

  it('rejects corrupted board JSON when required top-level fields are invalid', () => {
    expect(() => deserialize('{')).toThrow()
    expect(() => deserialize(JSON.stringify({ board: {}, camera: {}, items: [] }))).toThrow()
    expect(() =>
      deserialize(JSON.stringify({ schema: 'external/1.0', board: {}, camera: {}, items: [] })),
    ).toThrow()
    expect(() =>
      deserialize(JSON.stringify({ ...mixedBoard, items: {} })),
    ).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
    expect(() =>
      deserialize(JSON.stringify({ ...mixedBoard, camera: undefined })),
    ).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
  })

  it('validates cloud board objects directly without string reparse', () => {
    expect(parseBoardState(mixedBoard)).toEqual(mixedBoard)
    const invalidBoard: unknown = {
      ...mixedBoard,
      board: { ...mixedBoard.board, canvas: { bg: 123 } },
    }
    expect(() => parseBoardState(invalidBoard)).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
  })

  it('rejects corrupted board JSON when numeric fields are missing or not finite numbers', () => {
    expect(() =>
      deserialize(JSON.stringify({ ...mixedBoard, camera: { x: 0, y: 0, zoom: '1' } })),
    ).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
    expect(() =>
      deserialize(JSON.stringify({ ...mixedBoard, camera: { x: 0, y: 0, zoom: Number.NaN } })),
    ).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
    expect(() =>
      deserialize(JSON.stringify({ ...mixedBoard, items: [{ ...mixedBoard.items[0], opacity: '1' }] })),
    ).toThrow('유효한 RefBoard 보드 데이터가 아닙니다.')
  })
})
