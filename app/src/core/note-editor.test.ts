import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteEditor } from './note-editor'
import { Selection } from './selection'
import type { BoardNote, BoardState } from './board'
import type { Scene } from './scene'

const board: BoardState = {
  schema: 'refboard/1.0',
  board: { id: 'board-1', title: '보드', canvas: { bg: '#111111' } },
  camera: { x: 0, y: 0, zoom: 1 },
  items: [],
}

let host: HTMLDivElement
let hint: HTMLDivElement
let sel: Selection
let removedIds: string[]
let scene: Scene

beforeEach(() => {
  document.body.innerHTML = ''
  host = document.createElement('div')
  hint = document.createElement('div')
  sel = new Selection()
  removedIds = []
  scene = makeScene()
  document.body.append(host, hint)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('createNoteEditor', () => {
  it('updates the board note when an existing note is edited', async () => {
    const note: BoardNote = {
      id: 'note-1',
      type: 'note',
      text: '기존',
      fontSize: 20,
      color: '#ffffff',
      natural: { w: 100, h: 40 },
      transform: { x: 24, y: 32, scale: 1, rotation: 0 },
      opacity: 1,
      locked: false,
      z: 0,
    }
    board.items = [note]
    scene = makeScene(board)
    const editor = createNoteEditor({
      host,
      scene,
      board,
      sel,
      genId: () => 'generated',
      commit: () => {},
      afterEdit: () => {},
      updateMinimap: () => {},
      removeItem: (id) => {
        removedIds.push(id)
      },
      showToast: () => {},
      hintEl: hint,
      getTextDefaults: () => ({ color: '#ffffff', fontSize: 20, fontFamily: 'system-ui' }),
      worldToScreen: ({ x, y }) => ({ x, y }),
      getZoom: () => 1,
    })

    editor.open({ x: note.transform.x, y: note.transform.y }, note)
    const textarea = document.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    textarea.value = '수정된 노트'

    editor.commit()

    expect(board.items[0]?.type).toBe('note')
    if (board.items[0]?.type !== 'note') return
    expect(board.items[0].text).toBe('수정된 노트')
    expect(removedIds).toEqual([])
  })

  it('removes an existing note from the board when the text is cleared', () => {
    const keep: BoardNote = {
      id: 'note-keep',
      type: 'note',
      text: '남김',
      fontSize: 20,
      color: '#ffffff',
      natural: { w: 100, h: 40 },
      transform: { x: 8, y: 12, scale: 1, rotation: 0 },
      opacity: 1,
      locked: false,
      z: 0,
    }
    const remove: BoardNote = {
      id: 'note-remove',
      type: 'note',
      text: '삭제',
      fontSize: 20,
      color: '#ffffff',
      natural: { w: 100, h: 40 },
      transform: { x: 24, y: 32, scale: 1, rotation: 0 },
      opacity: 1,
      locked: false,
      z: 1,
    }
    board.items = [keep, remove]
    scene = makeScene(board)
    const editor = createNoteEditor({
      host,
      scene,
      board,
      sel,
      genId: () => 'generated',
      commit: () => {},
      afterEdit: () => {},
      updateMinimap: () => {},
      removeItem: (id) => {
        removedIds.push(id)
        const idx = board.items.findIndex((item) => item.id === id)
        if (idx >= 0) board.items.splice(idx, 1)
        board.items.forEach((item, index) => {
          item.z = index
        })
      },
      showToast: () => {},
      hintEl: hint,
      getTextDefaults: () => ({ color: '#ffffff', fontSize: 20, fontFamily: 'system-ui' }),
      worldToScreen: ({ x, y }) => ({ x, y }),
      getZoom: () => 1,
    })

    editor.open({ x: remove.transform.x, y: remove.transform.y }, remove)
    const textarea = document.querySelector('textarea')
    expect(textarea).not.toBeNull()
    if (!textarea) return
    textarea.value = '   '

    editor.commit()

    expect(removedIds).toEqual(['note-remove'])
    expect(board.items).toHaveLength(1)
    expect(board.items[0]?.id).toBe('note-keep')
    expect(board.items[0]?.z).toBe(0)
  })
})

function makeScene(itemsBoard: BoardState = board): Scene {
  const nodes = new Map<string, { visible: boolean }>()
  for (const item of itemsBoard.items) nodes.set(item.id, { visible: true })
  return {
    getNode: (id: string) => nodes.get(id),
    removeItem: (id: string) => {
      nodes.delete(id)
    },
    addNote: (note: BoardNote) => {
      nodes.set(note.id, { visible: true })
    },
    updateNote: (note: BoardNote) => note.natural,
    measureNote: () => ({ w: 100, h: 40 }),
  } as unknown as Scene
}
