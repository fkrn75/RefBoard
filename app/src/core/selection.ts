// 선택 상태 관리: 선택된 아이템 id 집합을 보관하고 변경 시 구독자에게 알린다.
// 렌더(외곽선)는 Scene이, 무엇을 선택할지는 main이 결정 — 이 모듈은 상태만 담당.
export class Selection {
  private ids = new Set<string>()
  private listeners = new Set<() => void>()

  get size(): number {
    return this.ids.size
  }
  has(id: string): boolean {
    return this.ids.has(id)
  }
  values(): string[] {
    return [...this.ids]
  }

  // 선택 교체
  set(ids: string[]) {
    this.ids = new Set(ids)
    this.emit()
  }
  // 선택 추가
  add(id: string) {
    if (!this.ids.has(id)) {
      this.ids.add(id)
      this.emit()
    }
  }
  // 선택 토글(Shift 다중선택용)
  toggle(id: string) {
    if (this.ids.has(id)) this.ids.delete(id)
    else this.ids.add(id)
    this.emit()
  }
  // 전체 해제
  clear() {
    if (this.ids.size > 0) {
      this.ids.clear()
      this.emit()
    }
  }

  // 변경 구독. 해제 함수를 반환.
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private emit() {
    for (const fn of this.listeners) fn()
  }
}
