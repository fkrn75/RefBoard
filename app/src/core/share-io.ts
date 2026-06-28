// 웹 뷰어 링크 공유 + 내 공유 보드 관리 패널 + 원격 이미지 인라인을 캡슐화한 모듈.
// main.ts God-file 분리(7.3). 어댑터(supabase-share)·다이얼로그는 직접 import하고,
// main의 보드 상태·토스트·복원 등은 deps로 주입받는다.
import { getShareAdapter } from './supabase-share'
import { openShareDialog } from './share-dialog'
import { openBoardManager } from './board-manager'
import { openConfirmDialog } from './dialog'
import { canDecodeImage, blobToDataURL } from './downscale'
import { isImageItem, type BoardState } from './board'

// 원격(서명 URL) 이미지를 data URL로 변환해 보드에 임베드한다. 같은 URL은 한 번만 받는다(orig=medium 중복 방지).
// 🔴 손상 방어: 실제로 디코드되는 이미지일 때만 채택한다. Cloudflare SPA fallback이 index.html을
// image/png로 돌려주는 사고처럼 content-type만으론 못 거르는 위장 데이터가 srcs에 박히면,
// 재공유(attachSrcSets→Storage)에서 다른 정상 이미지까지 오염된다. 디코드 실패 시 변환을 포기하고
// 기존 값(원격 URL)을 그대로 둔다 → 그 보드를 재공유하면 upload 가드가 명확히 실패시켜 진단 가능.
export async function inlineRemoteImages(state: BoardState): Promise<void> {
  const cache = new Map<string, string>() // URL → dataURL('' = 디코드 실패로 변환 포기)
  const conv = async (u: string): Promise<string | null> => {
    if (!u || !/^https?:/i.test(u)) return null // 비-URL(이미 dataURL/빈 값)은 변환 대상 아님 → 원본 유지
    const cached = cache.get(u)
    if (cached !== undefined) return cached || null
    let out = ''
    try {
      const resp = await fetch(u)
      if (!resp.ok) {
        console.warn('[inline] fetch 실패', resp.status, u)
      } else {
        const blob = await resp.blob()
        if (await canDecodeImage(blob)) out = await blobToDataURL(blob)
        else console.warn('[inline] 이미지가 아님(손상/HTML) — 인라인 건너뜀:', u)
      }
    } catch (e) {
      console.warn('[inline] fetch 예외:', u, e)
    }
    cache.set(u, out)
    return out || null
  }
  for (const it of state.items) {
    if (!isImageItem(it)) continue
    if (it.srcs) {
      const t = await conv(it.srcs.thumb)
      if (t) it.srcs.thumb = t
      const m = await conv(it.srcs.medium)
      if (m) it.srcs.medium = m
      const o = await conv(it.srcs.orig)
      if (o) it.srcs.orig = o
    }
    if (it.src) {
      const s = await conv(it.src)
      if (s) it.src = s
    }
  }
}

export interface ShareIoDeps {
  getBoard: () => BoardState
  restore: (state: BoardState, opts?: { keepCamera?: boolean }) => Promise<void>
  showToast: (msg: string, info?: boolean) => void
  showLoading: (text: string) => void
  hideLoading: () => void
  saveNow: () => void
  refreshBoardStatus: () => void
  setDirty: (v: boolean) => void
  getDirty: () => boolean
  setShareDisabled: (v: boolean) => void
}

export interface ShareIoApi {
  shareWebLink(): Promise<void>
  openBoardManagerPanel(): void
}

export function createShareIo(deps: ShareIoDeps): ShareIoApi {
  const viewerUrl = (): string => location.origin + '/viewer.html'
  let shareInProgress = false

  // 웹 뷰어 링크 공유: Supabase 키가 있으면 클라우드(로그인+허용목록+서명URL)로, 없으면 LocalShareAdapter
  // (같은 브라우저 목업)로 업로드하고 viewer.html#/b/<id> 링크를 클립보드에 복사한다.
  // 다중 해상도(thumb/medium/orig) 생성·원본 src 제거는 어댑터 내부에서 수행한다(Phase 5.1/5.3, P1#4).
  async function shareWebLink(): Promise<void> {
    if (shareInProgress) {
      deps.showToast('공유 업로드가 진행 중입니다', true)
      return
    }
    shareInProgress = true
    deps.setShareDisabled(true)
    try {
      const adapter = getShareAdapter(viewerUrl())
      // 클라우드 백엔드면 로그인 필요(목업은 항상 로그인 상태로 통과).
      const user = await adapter.getCurrentUser()
      if (!user) {
        deps.showToast('공유하려면 로그인이 필요합니다. 로그인 후 다시 공유를 눌러주세요…', true)
        await adapter.signIn() // 구글 OAuth 리다이렉트(돌아온 뒤 다시 공유)
        return
      }
      // 공유 옵션(공개 여부·만료·허용 이메일)을 모달로 입력받는다(M5). 취소하면 중단.
      const opts = await openShareDialog()
      if (!opts) return
      deps.showLoading('공유 준비 중…')
      const board = deps.getBoard()
      // 이미 공유한 보드면 그 board_id를 재사용해 같은 링크를 갱신한다(중복 누적 방지).
      const prevShareId = board.board.shareId
      const { id, url } = await adapter.upload(board, {
        isPublic: opts.isPublic,
        expiresAt: opts.expiresAt,
        allowEmails: opts.allowEmails,
        reuseId: prevShareId,
      })
      // 공유 id를 보드에 기억 → 다음 공유는 이 링크를 갱신. 즉시 자동저장으로 영속(브라우저를 닫아도 유지).
      board.board.shareId = id
      board.board.sharePublic = opts.isPublic
      deps.saveNow()
      deps.refreshBoardStatus() // 공유 상태 배지(공개/비공개) 즉시 갱신
      const updated = !!prevShareId && prevShareId === id
      try {
        await navigator.clipboard.writeText(url)
        deps.showToast((updated ? '기존 공유 링크 업데이트됨: ' : '웹 뷰어 링크 복사됨: ') + url, true)
      } catch {
        deps.showToast((updated ? '기존 공유 링크 갱신됨: ' : '웹 뷰어 링크: ') + url, true)
      }
    } catch (e) {
      console.error('[share] 업로드 실패:', e) // 진단: F12 콘솔에 전체 에러(테이블/정책/details) 노출
      deps.showToast(e instanceof Error ? e.message : '웹 공유 실패', true)
    } finally {
      shareInProgress = false
      deps.setShareDisabled(false)
      deps.hideLoading()
    }
  }

  // 내 공유 보드 관리 패널을 연다(목록·공개전환·삭제·링크복사). 데이터/삭제/전환은 어댑터에 위임.
  function openBoardManagerPanel(): void {
    const adapter = getShareAdapter(viewerUrl())
    openBoardManager({
      adapter,
      onToast: deps.showToast,
      // 클라우드 공유본을 편집 앱으로 불러온다(load → 원격 이미지 인라인 → restore).
      onLoadIntoEditor: async (id) => {
        if (deps.getDirty()) {
          const ok = await openConfirmDialog({
            title: '보드 불러오기',
            message: '저장하지 않은 변경이 있습니다.\n불러오면 현재 보드가 대체됩니다. 계속할까요?',
            confirmLabel: '불러오기',
            destructive: true,
          })
          if (!ok) return
        }
        deps.showToast('불러오는 중…', true)
        const res = await adapter.load(id)
        if (!res.ok) {
          deps.showToast('불러오기 실패: ' + res.reason, true)
          return
        }
        // 뷰어용 서명 URL(원격)을 data URL로 임베드 → 편집 앱은 항상 로컬 임베드 보드만 다룬다(재공유도 정상).
        await inlineRemoteImages(res.board)
        await deps.restore(res.board)
        deps.getBoard().board.shareId = id // 이 클라우드 보드에서 왔으니 재공유 시 같은 링크를 갱신.
        deps.saveNow()
        deps.setDirty(false) // 방금 클라우드 상태와 동일하므로 깨끗한 상태로 시작.
        deps.refreshBoardStatus()
        deps.showToast('편집 앱으로 불러왔어요', true)
      },
    })
  }

  return { shareWebLink, openBoardManagerPanel }
}
