// Undo/Redo 히스토리 — 보드 상태(BoardState) 전체 스냅샷을 스택에 쌓는 단순/안전한 방식.
//
// ── 사용 패턴 (호출측 = main.ts 연동) ──────────────────────────
//   1) 보드를 "변경하기 직전"에 현재 상태로 push 한다.
//        history.push(board)            // 변경 전 스냅샷 저장
//        ...board를 실제로 수정...       // (아이템 추가/이동/삭제/패킹 등)
//   2) Undo: 현재 상태를 넘기면(redo 보존용) 직전 상태를 돌려준다. 그 state로 보드 교체 후 재렌더.
//        const prev = history.undo(board)
//        if (prev) { board = prev; rerenderAll(board) }
//   3) Redo: 동일하게 현재 상태를 넘기고 반환 state로 교체 후 재렌더.
//        const next = history.redo(board)
//        if (next) { board = next; rerenderAll(board) }
//
// 핵심 규약:
//   - push 시점은 "변경 직전" 1회. 한 번의 사용자 동작 = 1 undo 단위.
//     (예: 자동 패킹은 패킹 직전에 딱 1회 push → 패킹 전체가 1 undo)
//   - undo/redo는 "현재 상태"(current)를 인자로 받아 반대편 스택에 보존한다.
//     이렇게 해야 undo→redo 왕복이 정확히 복원된다.
//
// 비용 주의 (structuredClone):
//   스냅샷은 structuredClone으로 깊은 복제한다. BoardImage.src 가 임베드(data URL)면
//   그 base64 문자열까지 통째로 복제되므로, 임베드 용량이 크면 스냅샷 1개 메모리가 클 수 있다.
//   상한(LIMIT)으로 누적 개수를 제한해 메모리 폭주를 막는다.

import type { BoardDrawing, BoardImage, BoardItem, BoardNote, BoardState, Crop, ImageSrcSet, Transform } from './board'

// 스택에 보관할 최대 스냅샷 개수. 초과 시 가장 오래된 항목부터 버린다.
const LIMIT = 200

export class History {
  // undo 스택: 과거 상태들(top = 가장 최근 변경의 직전 상태).
  private undoStack: BoardState[] = []
  // redo 스택: undo로 되돌렸을 때 보존된 "그 시점의 현재" 상태들. push가 들어오면 비운다.
  private redoStack: BoardState[] = []

  // 변경 직전에 호출. 현재 상태의 깊은 복제 스냅샷을 undo 스택에 쌓고 redo를 비운다.
  push(state: BoardState): void {
    this.undoStack.push(cloneBoardForHistory(state))
    this.redoStack.length = 0 // 새 변경 → 미래(redo) 분기 폐기
    if (this.undoStack.length > LIMIT) {
      this.undoStack.splice(0, this.undoStack.length - LIMIT)
    }
  }

  // 한 단계 되돌리기. current(현재 화면 상태)를 redo 스택에 보존하고, 직전 상태를 반환.
  // 되돌릴 게 없으면 null. 반환 state로 호출측이 board 교체 후 전체 재렌더해야 한다.
  undo(current: BoardState): BoardState | null {
    const prev = this.undoStack.pop()
    if (prev === undefined) return null
    this.redoStack.push(cloneBoardForHistory(current)) // 현재 상태를 redo용으로 보존(핵심)
    return cloneBoardForHistory(prev)
  }

  // 한 단계 다시 실행. current를 undo 스택으로 되돌리고, 앞선 상태를 반환.
  redo(current: BoardState): BoardState | null {
    const next = this.redoStack.pop()
    if (next === undefined) return null
    this.undoStack.push(cloneBoardForHistory(current)) // 현재 상태를 undo용으로 보존(핵심)
    return cloneBoardForHistory(next)
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }
  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  // 스택 전체 비우기(새 보드 로드/생성 시 호출 권장).
  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}

export function cloneBoardForHistory(state: BoardState): BoardState {
  return {
    schema: state.schema,
    board: {
      id: state.board.id,
      title: state.board.title,
      canvas: { bg: state.board.canvas.bg },
      ...(state.board.shareId !== undefined ? { shareId: state.board.shareId } : {}),
      ...(state.board.sharePublic !== undefined ? { sharePublic: state.board.sharePublic } : {}),
    },
    camera: { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom },
    items: state.items.map(cloneItem),
  }
}

function cloneTransform(transform: Transform): Transform {
  return {
    x: transform.x,
    y: transform.y,
    scale: transform.scale,
    rotation: transform.rotation,
    ...(transform.flipX !== undefined ? { flipX: transform.flipX } : {}),
    ...(transform.flipY !== undefined ? { flipY: transform.flipY } : {}),
  }
}

function cloneCrop(crop: Crop): Crop {
  return { x: crop.x, y: crop.y, w: crop.w, h: crop.h }
}

function cloneSrcSet(srcs: ImageSrcSet): ImageSrcSet {
  return { thumb: srcs.thumb, medium: srcs.medium, orig: srcs.orig }
}

function cloneImage(item: BoardImage): BoardImage {
  return {
    id: item.id,
    type: 'image',
    src: item.src,
    ...(item.srcs !== undefined ? { srcs: cloneSrcSet(item.srcs) } : {}),
    natural: { w: item.natural.w, h: item.natural.h },
    transform: cloneTransform(item.transform),
    ...(item.crop !== undefined ? { crop: cloneCrop(item.crop) } : {}),
    opacity: item.opacity,
    locked: item.locked,
    ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
    z: item.z,
    ...(item.comment !== undefined ? { comment: item.comment } : {}),
    ...(item.name !== undefined ? { name: item.name } : {}),
    ...(item.addedAt !== undefined ? { addedAt: item.addedAt } : {}),
  }
}

function cloneNote(item: BoardNote): BoardNote {
  return {
    id: item.id,
    type: 'note',
    text: item.text,
    fontSize: item.fontSize,
    ...(item.fontFamily !== undefined ? { fontFamily: item.fontFamily } : {}),
    color: item.color,
    natural: { w: item.natural.w, h: item.natural.h },
    transform: cloneTransform(item.transform),
    opacity: item.opacity,
    locked: item.locked,
    ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
    z: item.z,
  }
}

function cloneDrawing(item: BoardDrawing): BoardDrawing {
  return {
    id: item.id,
    type: 'drawing',
    tool: item.tool,
    points: item.points.map((point) => ({ x: point.x, y: point.y })),
    color: item.color,
    width: item.width,
    natural: { w: item.natural.w, h: item.natural.h },
    transform: cloneTransform(item.transform),
    opacity: item.opacity,
    locked: item.locked,
    ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
    z: item.z,
  }
}

function cloneItem(item: BoardItem): BoardItem {
  switch (item.type) {
    case 'image':
      return cloneImage(item)
    case 'note':
      return cloneNote(item)
    case 'drawing':
      return cloneDrawing(item)
  }
}
