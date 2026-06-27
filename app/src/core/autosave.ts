// 자동저장 / 크래시 복구 모듈 (RefBoard Phase 3).
//
// 설계 원칙:
//  - board.ts(serialize/deserialize)가 직렬화 포맷의 단일 진실 공급원. 이 모듈은
//    그 JSON 문자열만 다루고, BoardState 객체를 직접 보관하지 않는다(결합도 최소화).
//    getState()로 받은 상태는 즉시 serialize해 문자열로만 들고 다니며, round-trip
//    안전성(deserialize(serialize(x)))은 board.ts가 보장한다.
//  - 영속 계층은 IndexedDB(콜백 API)를 Promise로 직접 래핑해 사용한다(외부 의존성 0).
//    IndexedDB 미지원 환경(드묾)에서는 localStorage로 폴백한다 — 단 localStorage는
//    동기·문자열 전용이며 보통 5~10MB 한계라, data URL 임베드 이미지가 많은 큰 보드는
//    저장에 실패할 수 있다(아래 폴백 구현 주석 참조).
//  - 타이머·콜백만 담당하고, 실제 "복구할지 묻는 UI"나 "정상 저장 시 비우기" 같은
//    배선은 호출측(main.ts)이 담당한다(단일 writer는 main).

import { serialize, deserialize, type BoardState } from './board'

// ---- 영속 상수 ----
const DB_NAME = 'refboard' // IndexedDB 데이터베이스 이름
const DB_VERSION = 1
const STORE = 'autosave' // 오브젝트 스토어(키-값) 이름
const SNAPSHOT_KEY = 'recovery' // 크래시 복구용 스냅샷의 고정 키(항상 최신 1개만 유지)
const LS_FALLBACK_KEY = 'refboard.autosave.recovery' // localStorage 폴백 키

// 디스크에 저장되는 스냅샷 레코드. board는 serialize된 JSON 문자열로만 보관한다.
interface Snapshot {
  schema: 'refboard.autosave/1' // 스냅샷 레코드 자체의 버전(보드 schema와 별개)
  ts: number // 저장 시각(Date.now(), epoch ms) — 복구 프롬프트에 "n분 전" 표기용
  board: string // serialize(BoardState) 결과 JSON 문자열
}

// AutoSave 생성자 옵션.
export interface AutoSaveOptions {
  // 자동저장 주기(ms). 기본 5분. start() 이후에도 setIntervalMs로 변경 가능.
  intervalMs?: number
  // 저장 시점에 현재 보드 상태를 돌려주는 콜백(필수). main이 scene의 현재 상태를 넘긴다.
  getState: () => BoardState
  // 1회 저장 성공 시 통지(선택) — 예: 상태바에 "자동저장됨" 잠깐 표시.
  onSaved?: () => void
  // 저장 실패 시 통지(선택) — 예: 콘솔 경고. 미지정 시 조용히 무시(주기 저장 지속).
  onError?: (e: unknown) => void
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000 // 5분

export class AutoSave {
  private intervalMs: number
  private readonly getState: () => BoardState
  private readonly onSaved?: () => void
  private readonly onError?: (e: unknown) => void
  private readonly tabId: string
  private readonly channel: BroadcastChannel | null
  private lastObservedRemoteTs = 0

  // setInterval 핸들. 미동작 시 null. (브라우저 환경이라 number 타입)
  private timer: number | null = null
  // saveNow가 겹쳐 호출돼도 IndexedDB 쓰기가 직렬화되도록 직전 작업을 물고 이어간다.
  private writeChain: Promise<void> = Promise.resolve()

  constructor(opts: AutoSaveOptions) {
    this.intervalMs = normalizeInterval(opts.intervalMs)
    this.getState = opts.getState
    this.onSaved = opts.onSaved
    this.onError = opts.onError
    this.tabId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    this.channel = typeof globalThis.BroadcastChannel !== 'undefined' ? new BroadcastChannel('refboard.autosave') : null
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent) => {
        const data = event.data as unknown
        if (!data || typeof data !== 'object') return
        const msg = data as { tabId?: unknown; ts?: unknown }
        if (msg.tabId === this.tabId) return
        if (typeof msg.ts === 'number' && msg.ts > this.lastObservedRemoteTs) {
          this.lastObservedRemoteTs = msg.ts
        }
      }
    }
  }

  // 주기적 자동저장 시작. 이미 동작 중이면 기존 타이머를 정리하고 다시 건다(중복 방지).
  // 호출 즉시 저장하지는 않는다 — 첫 저장은 intervalMs 후. (시작 직후 즉시 1회가 필요하면
  // 호출측에서 saveNow()를 별도로 부른다.)
  start(): void {
    this.stop()
    this.timer = globalThis.setInterval(() => {
      // 타이머 콜백에서 throw가 새어 나가지 않도록 saveNow 내부에서 onError로 처리한다.
      void this.saveNow()
    }, this.intervalMs)
  }

  // 주기적 자동저장 중지. 타이머만 해제하며, 이미 기록된 스냅샷은 그대로 둔다.
  stop(): void {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer)
      this.timer = null
    }
  }

  // 자동저장 주기를 변경한다. 동작 중이면 새 주기로 타이머를 다시 건다.
  setIntervalMs(ms: number): void {
    this.intervalMs = normalizeInterval(ms)
    if (this.timer !== null) this.start() // start가 stop→재설정을 처리
  }

  // 지금 즉시 1회 저장한다(수동 트리거 또는 타이머 콜백 공용).
  // - 직렬화는 동기적으로 "현재 시점" 상태를 즉시 캡처해, 이후 비동기 쓰기 중 상태가
  //   바뀌어도 캡처한 스냅샷이 일관되게 기록되도록 한다.
  // - 여러 번 겹쳐 불려도 writeChain으로 순차 직렬화해 IndexedDB 트랜잭션이 꼬이지 않게 한다.
  // - 실패는 onError로만 통지하고 reject하지 않는다(주기 저장이 한 번의 실패로 멈추지 않도록).
  saveNow(): Promise<void> {
    // 상태 캡처·직렬화를 동기 구간에서 먼저 끝낸다.
    let json: string
    try {
      json = serialize(this.getState())
    } catch (e) {
      this.onError?.(e)
      return Promise.resolve()
    }
    const snapshot: Snapshot = {
      schema: 'refboard.autosave/1',
      ts: Date.now(),
      board: json,
    }

    return this.readSnapshot()
      .then((current) => {
        const currentTs = current?.ts ?? 0
        if (currentTs > snapshot.ts || this.lastObservedRemoteTs > snapshot.ts) {
          this.onError?.(new Error('다른 탭의 자동저장본이 더 최신입니다'))
          return
        }

        // 직전 쓰기에 이어 붙여 순차 실행. catch로 체인이 끊기지 않게 흡수한다.
        this.writeChain = this.writeChain.then(
          () => this.persist(snapshot),
          () => this.persist(snapshot), // 직전 실패와 무관하게 이번 저장은 시도
        )
        return this.writeChain.then(() => {
          if (snapshot.ts > this.lastObservedRemoteTs) this.lastObservedRemoteTs = snapshot.ts
          this.channel?.postMessage({ tabId: this.tabId, ts: snapshot.ts })
        })
      })
      .catch((e) => {
        this.onError?.(e)
      })
  }

  // 크래시 복구용 스냅샷이 존재하는지 여부.
  async hasRecovery(): Promise<boolean> {
    const snap = await this.readSnapshot()
    return snap !== null
  }

  // 크래시 복구용 스냅샷을 BoardState로 복원해 반환한다(없거나 손상되면 null).
  // 손상(파싱 실패) 시에는 onError로 통지만 하고 null을 돌려준다 — 복구 실패가 곧
  // 앱 시작 실패가 되지 않도록.
  async loadRecovery(): Promise<BoardState | null> {
    const snap = await this.readSnapshot()
    if (!snap) return null
    try {
      return deserialize(snap.board)
    } catch (e) {
      this.onError?.(e)
      return null
    }
  }

  // 복구 스냅샷의 저장 시각(epoch ms)을 반환한다(없으면 null).
  // 복구 프롬프트에서 "n분 전 자동저장본" 같은 안내에 쓸 수 있게 메타만 노출.
  async getRecoveryTimestamp(): Promise<number | null> {
    const snap = await this.readSnapshot()
    return snap ? snap.ts : null
  }

  // 복구 스냅샷을 비운다. 정상적으로 .refb 저장이 끝난 직후 호출측이 불러 "복구 대기"를
  // 해제하는 용도. 없으면 무시(idempotent).
  async clearRecovery(): Promise<void> {
    if (isIdbAvailable()) {
      try {
        await idbDelete(SNAPSHOT_KEY)
        return
      } catch (e) {
        // IndexedDB 삭제 실패 시 폴백 키도 함께 정리 시도(이중 안전).
        this.onError?.(e)
      }
    }
    try {
      globalThis.localStorage?.removeItem(LS_FALLBACK_KEY)
    } catch (e) {
      this.onError?.(e)
    }
  }

  // ---- 내부 구현 ----

  // 스냅샷을 영속 계층에 기록한다. IndexedDB 우선, 미지원이면 localStorage 폴백.
  // 성공 시 onSaved, 실패 시 onError 통지.
  private async persist(snapshot: Snapshot): Promise<void> {
    try {
      if (isIdbAvailable()) {
        await idbPut(SNAPSHOT_KEY, snapshot)
      } else {
        // localStorage 폴백: 동기·문자열 전용, 보통 5~10MB 한계. data URL 이미지를
        // 많이 임베드한 큰 보드는 QuotaExceededError로 실패할 수 있다(그 경우 onError).
        persistToLocalStorage(snapshot)
      }
      this.onSaved?.()
    } catch (e) {
      this.onError?.(e)
    }
  }

  // 영속 계층에서 스냅샷 레코드를 읽어 온다. IndexedDB 우선, 폴백 localStorage.
  // 어느 쪽에서도 없거나 형식이 맞지 않으면 null.
  private async readSnapshot(): Promise<Snapshot | null> {
    if (isIdbAvailable()) {
      try {
        const v = await idbGet(SNAPSHOT_KEY)
        return asSnapshot(v)
      } catch (e) {
        // IndexedDB 읽기 실패 시 폴백 경로도 시도(이중 안전).
        this.onError?.(e)
      }
    }
    return readFromLocalStorage()
  }
}

// ---- 모듈 전역 헬퍼(상태 없음) ----

// 주기 값 보정: 유한한 양수만 허용하고, 그 외(NaN/0/음수/undefined)는 기본값으로.
function normalizeInterval(ms: number | undefined): number {
  return typeof ms === 'number' && ms > 0 && Number.isFinite(ms) ? ms : DEFAULT_INTERVAL_MS
}

// 임의 값이 Snapshot 형태인지 좁혀서 확인(역직렬화·구버전 방어).
function asSnapshot(v: unknown): Snapshot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.schema !== 'refboard.autosave/1') return null
  if (typeof o.ts !== 'number' || typeof o.board !== 'string') return null
  return { schema: 'refboard.autosave/1', ts: o.ts, board: o.board }
}

// IndexedDB 사용 가능 여부(브라우저 외 환경·프라이빗 모드 일부 차단 방어).
function isIdbAvailable(): boolean {
  try {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null
  } catch {
    // 일부 환경은 indexedDB 접근 자체에서 SecurityError를 던진다.
    return false
  }
}

// DB 핸들을 열어(필요 시 스토어 생성) Promise로 반환한다. 호출마다 새로 열고,
// 작업 후 닫는다 — 자동저장 빈도(분 단위)에서는 연결 풀링의 이득이 작고 단순함이 낫다.
function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    // 최초/버전업 시 오브젝트 스토어 생성. 키는 명시적으로 우리가 부여(out-of-line).
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 열기 실패'))
    // 다른 탭이 더 낮은 버전으로 열고 있어 업그레이드가 막힌 경우.
    req.onblocked = () => reject(new Error('IndexedDB 업그레이드가 다른 탭에 의해 차단됨'))
  })
}

// 하나의 트랜잭션을 열어 작업(op)을 수행하고, 트랜잭션 완료까지 기다린 뒤 db를 닫는다.
// op는 IDBRequest를 돌려주며, 그 결과를 트랜잭션 commit 후 resolve한다.
async function withStore<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const store = tx.objectStore(STORE)
      const req = op(store)
      let result: T
      req.onsuccess = () => {
        result = req.result as T
      }
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 요청 실패'))
      // 트랜잭션이 실제로 커밋된 뒤에 resolve해야 쓰기 내구성이 보장된다.
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션 실패'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 트랜잭션 중단'))
    })
  } finally {
    db.close()
  }
}

// 키-값 put(덮어쓰기). 키는 out-of-line이라 (value, key) 순서로 넘긴다.
function idbPut(key: string, value: Snapshot): Promise<void> {
  return withStore<void>('readwrite', (store) => store.put(value, key))
}

// 키로 값 조회. 없으면 undefined가 결과로 온다.
function idbGet(key: string): Promise<unknown> {
  return withStore<unknown>('readonly', (store) => store.get(key))
}

// 키로 값 삭제(없어도 성공).
function idbDelete(key: string): Promise<void> {
  return withStore<void>('readwrite', (store) => store.delete(key))
}

// ---- localStorage 폴백(IndexedDB 미지원 환경 전용) ----
// 동기·문자열 전용이며 용량 한계(보통 5~10MB)가 있어 큰 보드는 실패할 수 있다.

function persistToLocalStorage(snapshot: Snapshot): void {
  const ls = globalThis.localStorage
  if (!ls) throw new Error('localStorage 사용 불가(영속 계층 없음)')
  // 스냅샷 레코드 전체를 한 번 더 JSON 문자열화해 단일 키에 저장.
  ls.setItem(LS_FALLBACK_KEY, JSON.stringify(snapshot))
}

function readFromLocalStorage(): Snapshot | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_FALLBACK_KEY)
    if (!raw) return null
    return asSnapshot(JSON.parse(raw))
  } catch {
    // 파싱 실패·접근 차단 모두 "복구본 없음"으로 간주(앱 시작을 막지 않음).
    return null
  }
}
