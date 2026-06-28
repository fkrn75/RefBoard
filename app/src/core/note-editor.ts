import { normalizeZ } from './zorder'
import type { BoardNote, BoardState } from './board'
import type { Scene } from './scene'
import type { Selection } from './selection'

interface NoteEditorDeps {
  host: HTMLElement
  scene: Scene
  board: BoardState
  sel: Selection
  genId: () => string
  commit: () => void
  afterEdit: () => void
  updateMinimap: () => void
  removeItem: (id: string) => void
  showToast: (message: string, info?: boolean) => void
  hintEl: HTMLElement
  getTextDefaults: () => { color: string; fontSize: number; fontFamily: string }
  worldToScreen: (world: { x: number; y: number }) => { x: number; y: number }
  getZoom: () => number
}

export interface NoteEditorApi {
  open(world: { x: number; y: number }, existing?: BoardNote): void
  commit(): void
  cancel(): void
  isOpen(): boolean
}

export function createNoteEditor(deps: NoteEditorDeps): NoteEditorApi {
  let noteEditor: HTMLTextAreaElement | null = null
  let editingNoteId: string | null = null
  let noteEditorWorld = { x: 0, y: 0 }

  const dispose = (): void => {
    if (!noteEditor) return
    const ed = noteEditor
    noteEditor = null
    ed.remove()
    if (editingNoteId) {
      const s = deps.scene.getNode(editingNoteId)
      if (s) s.visible = true
    }
    editingNoteId = null
  }

  const ensureNoteFont = (note: BoardNote): void => {
    if (!note.fontFamily) return
    document.fonts
      .load(`${note.fontSize}px ${note.fontFamily}`)
      .then(() => {
        const m = deps.scene.updateNote(note)
        if (m) note.natural = m
        if (deps.sel.values().includes(note.id)) deps.afterEdit()
      })
      .catch(() => {})
  }

  const commit = (): void => {
    if (!noteEditor) return
    const text = noteEditor.value.replace(/\s+$/g, '')
    const id = editingNoteId
    dispose()

    if (id) {
      const note = deps.board.items.find((item): item is BoardNote => item.id === id && item.type === 'note') ?? null
      if (!note || note.type !== 'note') return
      if (text.length === 0) {
        deps.commit()
        deps.removeItem(id)
        deps.sel.clear()
        deps.afterEdit()
        if (deps.board.items.length === 0) {
          deps.hintEl.style.display = ''
        }
        return
      }
      if (text === note.text) return
      deps.commit()
      note.text = text
      const m = deps.scene.updateNote(note)
      if (m) note.natural = m
      else note.natural = deps.scene.measureNote(text, note.fontSize, note.color, note.fontFamily)
      deps.afterEdit()
      return
    }

    if (text.length === 0) return
    const { color, fontSize, fontFamily } = deps.getTextDefaults()
    const natural = deps.scene.measureNote(text, fontSize, color, fontFamily)
    const note: BoardNote = {
      id: deps.genId(),
      type: 'note',
      text,
      fontSize,
      fontFamily,
      color,
      natural,
      transform: { x: noteEditorWorld.x, y: noteEditorWorld.y, scale: 1, rotation: 0 },
      opacity: 1,
      locked: false,
      z: deps.board.items.length,
    }
    deps.commit()
    deps.board.items.push(note)
    try {
      deps.scene.addNote(note)
    } catch (err) {
      console.warn('[note] 노트 렌더링 실패', err)
      deps.showToast('노트를 화면에 추가하지 못했습니다.')
      deps.removeItem(note.id)
      deps.board.items = deps.board.items.filter((item) => item.id !== note.id)
      normalizeZ(deps.board.items)
      deps.sel.clear()
      deps.updateMinimap()
      return
    }
    ensureNoteFont(note)
    deps.hintEl.style.display = 'none'
    deps.sel.set([note.id])
    deps.updateMinimap()
  }

  return {
    open(world, existing): void {
      commit()
      editingNoteId = existing ? existing.id : null
      noteEditorWorld = world
      const defaults = deps.getTextDefaults()
      const fontSize = existing ? existing.fontSize : defaults.fontSize
      const color = existing ? existing.color : defaults.color
      const family = existing ? existing.fontFamily ?? defaults.fontFamily : defaults.fontFamily
      const ta = document.createElement('textarea')
      ta.value = existing ? existing.text : ''
      ta.spellcheck = false
      ta.rows = 1
      const sp = deps.worldToScreen(world)
      const screenFont = Math.max(8, fontSize * deps.getZoom())
      ta.style.cssText = [
        'position:absolute',
        `left:${sp.x}px`,
        `top:${sp.y}px`,
        'transform:translate(-50%,-50%)',
        'z-index:60',
        'margin:0',
        'padding:2px 4px',
        'border:1px dashed var(--rb-accent, #4aa3ff)',
        'border-radius:4px',
        'background:rgba(0,0,0,.35)',
        `color:${color}`,
        `font:${screenFont}px ${family}`,
        'line-height:1.2',
        'white-space:pre',
        'overflow:hidden',
        'resize:none',
        'min-width:1ch',
        'outline:none',
        'caret-color:var(--rb-accent, #4aa3ff)',
      ].join(';')
      deps.host.appendChild(ta)
      noteEditor = ta
      const autosize = (): void => {
        ta.style.width = 'auto'
        ta.style.height = 'auto'
        ta.style.width = Math.max(ta.scrollWidth + 4, 16) + 'px'
        ta.style.height = ta.scrollHeight + 'px'
      }
      ta.addEventListener('input', autosize)
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          dispose()
        }
      })
      ta.addEventListener('blur', () => commit())
      if (existing) {
        const s = deps.scene.getNode(existing.id)
        if (s) s.visible = false
      }
      setTimeout(() => {
        ta.focus()
        autosize()
      }, 0)
    },
    commit,
    cancel(): void {
      dispose()
    },
    isOpen(): boolean {
      return noteEditor !== null
    },
  }
}
