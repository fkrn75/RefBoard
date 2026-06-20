# RefBoard 웹 공유 백엔드 설계 — Supabase(로그인 + 허용 목록 + 무료)

> 작성: 2026-06-19 · 상태: **설계(구현 전)** · 관련 체크리스트: 5.0 BaaS 선정, 5.1 업로드, 5.4 권한·보안
> 전제 결정(사용자 확정): **무료(카드 미등록 → 과금 원천 차단), 강한 접근제어(로그인 + 이메일 허용 목록), 한도 초과 시 정지(과금 X), 실시간 동기화 제외.**
>
> ⚠️ **적대검증 결과(2026-06-20, 5라운드/31에이전트): 조건부 No-Go.** 방향은 타당하나 그대로 구현 시 접근제어가 뚫리고(P1#1·#2) 무료 한도가 '복구 불가 데드락'이 된다(P1#3~#7). 상세·근거는 [16절](#16-적대검증5라운드-결과--착수-전-필수-선결) 참조.
> ✅ **v2(2026-06-20): P1 7건 본문 반영 완료** — 4·5·6·8·9·11·12·13·14·15절에 통합(16절은 검증 이력 원문으로 보존). `srcset.ts` P1#4는 **코드 반영 완료**(일반 이미지 src 비움); crop·GIF 경량본·Storage 키 치환은 SupabaseShareAdapter(M3, 키 발급 후). 이제 **Go 조건 충족 — M1(사용자 키 발급)부터 착수 가능.**

## 1. 목표와 제약

| 항목 | 결정 |
|---|---|
| 비용 | Supabase **Free**. 카드 미등록 → Pro 자동전환 불가 → 한도 초과 시 **제한(capped)**, 청구 없음 |
| 접근 제어 | **로그인(Auth) + 이메일 허용 목록(allowlist) + RLS** — id를 알아도 권한 없으면 서버가 거부 |
| 파일 | 이미지는 **비공개 Storage 버킷 + 서명 URL**(만료 포함). 다중해상도(`srcs`)를 해상도별 분리 저장 → egress 절감 |
| 라우팅 | 기존 `ShareAdapter` 인터페이스를 **확장**해 끼움. 데스크탑/뷰어 상위 로직은 최소 변경 |
| 실시간 | 미사용(열 때 1회 로드). 협업 메모는 후속(같은 DB에 댓글 테이블 추가) |

## 2. 아키텍처

```
[데스크탑 앱(작성자)]
   1) 작성자 로그인(Auth)
   2) attachSrcSets(board) → 이미지별 thumb/medium/orig(data URL) 생성  ← 이미 구현됨
   3) 각 해상도를 Storage 비공개 버킷에 업로드
   4) boards(메타+Storage키) insert, board_allowlist(허용 이메일) insert
        │
        ▼
[Supabase]  Auth · Postgres(RLS) · Storage(비공개)
        ▲
        │
[뷰어(모바일/PC, 공유받는 사람)]
   1) 링크 #/b/<id> 진입 → 로그인(구글 원탭)
   2) boards select (RLS가 "허용목록∋내이메일?" 검증)
   3) 통과 시 srcs를 서명 URL로 치환 → scene 렌더(medium) / 라이트박스(orig)
   4) 거부 시 "권한 없음 / 로그인 필요 / 만료" 화면
```

## 3. Supabase 리소스

- **Auth**: 구글 OAuth(원탭) 1순위 + 매직링크(이메일) 폴백. MAU 50,000 무료.
- **Storage**: 비공개 버킷 `boards`(공개 접근 차단, 서명 URL로만 다운로드).
- **DB**: Postgres + RLS(행 단위 권한). 모든 표에 RLS 강제(anon key는 공개되므로 RLS가 유일한 방어선).

## 4. DB 스키마

```sql
-- 보드 메타(이미지 바이너리는 Storage, 여기엔 구조/참조만)
create table boards (
  id          text primary key,                 -- 고엔트로피 ID(nanoid 22자 ≈132bit 또는 UUID). genId() 12자(48bit)는 enumerate 취약 → 확대(P1#2)
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  data        jsonb not null,                   -- BoardState(단, items[].srcs는 Storage '키' 저장)
  status      text not null default 'uploading' check (status in ('uploading','ready')), -- P1#5: 업로드 완료 전 orphan/부분노출 방지
  is_public   boolean not null default false,   -- true면 허용목록 무시(공개 보드)
  password_hash text,                           -- 선택: '중' 수준 비번 병행 시
  expires_at  timestamptz,                      -- 선택: 만료(null=무기한)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 보드별 허용 이메일(화이트리스트)
create table board_allowlist (
  board_id text not null references boards(id) on delete cascade,
  email    text not null,                       -- 소문자 정규화해 저장
  primary key (board_id, email)
);

create index on board_allowlist (email);

-- is_allowed(): RLS 단일 게이트. SECURITY DEFINER로 호출자 권한과 무관하게 함수 소유자 권한으로 실행.
-- 미검증 email 클레임(매직링크 미확인/임의 provider) 신뢰를 차단 — email_verified + aud 동시 검증(P1#1).
create or replace function is_allowed(p_board_id text)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from board_allowlist a
    where a.board_id = p_board_id
      and a.email = lower(auth.jwt() ->> 'email')
  )
  and (auth.jwt() ->> 'email_verified')::boolean is true
  and auth.jwt() ->> 'aud' = 'authenticated';
$$;
```

## 5. RLS 정책 (핵심 — 진짜 격리)

```sql
alter table boards          enable row level security;
alter table board_allowlist enable row level security;

-- 소유자: 자기 보드 전권(작성/수정/삭제)
create policy boards_owner_all on boards
  for all  using (owner = auth.uid())
           with check (owner = auth.uid());

-- 읽기: (공개) 또는 (소유자) 또는 (is_allowed() 통과) + 만료 안 됨
create policy boards_read on boards
  for select using (
    (expires_at is null or expires_at > now())
    and (
      is_public
      or owner = auth.uid()
      or is_allowed(boards.id)   -- SECURITY DEFINER: email_verified + aud 내부 검증(P1#1)
    )
  );

-- 허용목록: 해당 보드 소유자만 관리
create policy allowlist_owner on board_allowlist
  for all using (
    exists (select 1 from boards b where b.id = board_id and b.owner = auth.uid())
  );
```

> 핵심: 뷰어는 anon key로 접속하지만, `select`는 RLS를 통과해야만 행을 받는다. id를 알아도 허용목록에 없으면 **0행 반환 = 접근 거부**. 허용목록 검증은 `is_allowed()` SECURITY DEFINER 함수로 단일화 — 미검증 email 클레임(매직링크 미확인 등)으로 우회하는 공격을 차단(`email_verified: true` + `aud: 'authenticated'` 동시 검증, P1#1).

## 6. Storage 구조 + 다중해상도 연계

비공개 버킷 `boards`. 경로 규약:
```
{board_id}/{image_id}/thumb.webp
{board_id}/{image_id}/medium.webp
# orig는 기본 미저장(P1#3) — 공유·라이트박스 모두 medium 재사용.
# orig 저장은 명시 옵트인("고화질 보존" 체크) 시에만: {board_id}/{image_id}/orig.{ext}
```

- **Storage RLS(강제, P1#2)**: `storage.objects`에 SELECT RLS를 **반드시** 적용한다. 클라이언트 로직("DB select 성공 시 createSignedUrl") 위임은 방어선이 아님 — anon key가 공개라 DB가 0행을 반환해도 공격자가 키 경로를 추측해 직접 `createSignedUrl`을 호출할 수 있다. board_id로 파싱해 `boards_read`와 **동일한 `is_allowed()`** 로 게이트:
  ```sql
  create policy storage_boards_read on storage.objects
    for select using (
      bucket_id = 'boards'
      and is_allowed((storage.foldername(name))[1])
    );
  ```
- **board_id 고엔트로피화 필수(P1#2)**: 경로 `{board_id}/{image_id}/...` 구조상 board_id 추측 공격이 가능 — `genId()` 12자(48bit)→`nanoid(22)`(≈132bit) 또는 `crypto.randomUUID()`로 확대(4절 `boards.id`에 반영).
- **board.json의 `srcs`는 data URL이 아니라 Storage '키'**(예: `verify/abc/medium.webp`)를 저장 → DB 용량 최소화.
- **load 시 어댑터가 키 → 서명 URL로 치환**해 반환. **medium은 장수명 서명URL(7d)+`Cache-Control: max-age=604800`**(1h 토큰 회전 시 매시간 재다운로드→egress 5GB 조기소진 방지, P1#6), orig(옵트인 시)는 라이트박스 클릭 시점 온디맨드 단축(1h). 뷰어 `scene`/`lightbox`는 `srcs.medium`/`srcs.orig`를 문자열 src로 받으므로 **무수정**(현재 다중해상도 구현이 그대로 동작). 장기적으론 이미지를 egress 무제한 Cloudflare(R2/Pages)로 이전해 Supabase는 메타·권한만 담당하는 구조로 발전 가능.

> 이 분리 저장이 다중해상도의 진짜 이득 실현 지점 — 보드뷰는 medium만 fetch하므로 egress가 orig 대비 ~20배 절감(이번 구현에서 측정).

## 7. ShareAdapter 인터페이스 확장

현재(`src/core/share-adapter.ts`):
```ts
interface ShareAdapter {
  upload(board: BoardState): Promise<{ id: string; url: string }>
  getShareUrl(id: string): string
  load(id: string): Promise<BoardState | null>
}
```

확장안:
```ts
// 로드 결과 — 성공이면 보드, 실패면 사유(뷰어가 화면 분기)
type LoadResult =
  | { ok: true; board: BoardState }
  | { ok: false; reason: 'auth-required' | 'forbidden' | 'expired' | 'not-found' }

interface ShareAdapter {
  // 업로드: 허용목록/공개/만료 옵션 추가
  upload(board: BoardState, opts?: {
    allowEmails?: string[]
    isPublic?: boolean
    expiresAt?: Date
  }): Promise<{ id: string; url: string }>

  getShareUrl(id: string): string
  load(id: string): Promise<LoadResult>          // null 대신 사유 포함 결과

  // 인증(신규)
  getCurrentUser(): Promise<{ email: string } | null>
  signIn(): Promise<void>                         // 구글 OAuth
  signOut(): Promise<void>

  // 허용목록 관리(신규, 작성자용)
  setAllowlist(id: string, emails: string[]): Promise<void>
}
```

> 기존 `LocalShareAdapter`는 신규 메서드를 stub(항상 로그인된 것처럼, `load`는 `{ok:true}` 래핑)으로 구현해 하위호환 유지. 상위(`shareWebLink`, `loadHashBoard`)는 어댑터 교체만으로 동작.

## 8. 업로드 흐름 (작성자) — `main.ts shareWebLink` 확장

```
1. user = await adapter.getCurrentUser(); if (!user) await adapter.signIn()
2. const id = nanoid(22)                                   // 고엔트로피 board_id(P1#2)
   await boards.insert({ id, owner, title, data:{}, status:'uploading', expires_at })  // P1#5: 행 먼저
   try {
3.   const shared = await attachSrcSets(board)             // srcs(data URL) 생성 + src 비움(코드 반영 완료, P1#4)
     for each item in shared.items:
       if (item.srcs) {                                    // 일반 이미지
         srcs.thumb/medium(+orig는 옵트인) → Blob → Storage upload({id}/{itemId}/*.webp)
         item.srcs = { thumb:'키', medium:'키' }           // data URL → Storage 키. src는 이미 '' (attachSrcSets)
       } else {                                            // crop·GIF(srcs 없음)
         const light = await makeLightCopy(item)           // crop 영역 잘라 medium / GIF 대표 프레임
         upload(light); item.src = '키'                    // 원본 대용량 data URL → Storage 키
       }
     assertNoDataUrls(shared)                              // 가드: jsonb에 'data:' 잔존 시 throw
4.   await boards.update({ id, data: shared, status:'ready' })          // 완료 후에만 ready
5.   board_allowlist.insert(allowEmails.map(e => ({ board_id:id, email:lower(e) })))
6.   return `${deployUrl}/viewer.html#/b/${id}`
   } catch (e) {                                           // P1#5: 보상삭제
     await storage.remove([`${id}/`]); await boards.delete().eq('id', id); throw e
   }
   // 고아 GC(cron): status='uploading' AND created_at < now()-1h 주기 정리
```

UI: 공유 버튼 → 모달(허용 이메일 입력 textarea + 공개 토글 + 만료 선택) → 진행 표시(다중해상도 생성·업로드).

## 9. 로드 흐름 (뷰어) — `viewer/main.ts loadHashBoard` 확장

```
1. id = parse(#/b/<id>)
2. user = await adapter.getCurrentUser()
   - 없음 → 화면: "이 보드는 로그인이 필요합니다 [구글로 계속]" → signIn()
3. const r = await adapter.load(id)     // 내부에서 boards.select (RLS 검증)
   - r.ok === false:
       'forbidden'    → "접근 권한이 없습니다(소유자에게 요청)"
       'expired'      → "만료된 링크입니다"
       'not-found'    → "보드를 찾을 수 없습니다"
       'auth-required'→ 로그인 유도
4. r.ok: board.items[].srcs를 해상도별 차등 서명URL로 치환(P1#6):
   - medium: createSignedUrl(키, 604800s /*7d*/) + Cache-Control: max-age=604800
   - orig(옵트인 시): 라이트박스 클릭 시 createSignedUrl(키, 3600s) 온디맨드 단축
5. scene.rebuild(board.items)  // medium 렌더 / 라이트박스 orig — 기존 그대로
```

## 10. Auth 흐름 주의점

- 구글 OAuth 리다이렉트가 `#/b/<id>` 해시를 날릴 수 있음 → signIn 전 `localStorage`에 복귀용 id 저장, 콜백 후 복원.
- 세션은 `@supabase/supabase-js`가 localStorage에 자동 관리(재방문 시 자동 로그인).
- 매직링크 폴백: 구글 계정 없는 뷰어용(이메일로 1회용 링크).

## 11. 무료 티어 운영

| 자원 | 무료 한도 | RefBoard에서 | 초과 시 |
|---|---|---|---|
| DB | 500MB | 메타·허용목록(작음) → 여유 | 쓰기 제한 |
| **Storage** | **1GB** | 이미지 → **먼저 닳음** | 업로드 정지 |
| **Egress** | **5GB/월** | medium 7d 서명URL+캐시로 완화(P1#6), 80% 알림 필요 | 다운로드 정지(권한 통과해도 바이너리 0) |
| MAU | 50,000 | 충분 | — |

- **카드 미등록 = 과금 0**(원하신 "넘으면 정지" 보장).
- **1주 비활성 → 프로젝트 일시정지**(무료 함정): 단일 ping은 지연/스킵/60일 자동비활성·무알림 리스크 → **2개 이상 이중화 필수(P1#7)**: ①GitHub Actions cron(`0 9 * * *`) ②cron-job.org 백업(다른 시간대). 둘 다 `/health` 확인 후 실패 시 경보(Slack/이메일). 중요 보드는 자기완결 HTML(`share-export.ts`)로도 이중 보관.
- **Storage 1GB 관리(P1#3)**: orig 기본 미저장 — medium(~80KB/장)만 사용. 80장 보드면 ≈6.4MB → 보드 ~150개(orig 포함 시 4~5개). 공유 모달에 잔여 용량 표시 + 업로드 전 사전 가드. **보드 삭제 UI + Storage cascade는 M3 필수**.

## 12. 기존 코드 변경 지점

| 파일 | 변경 |
|---|---|
| `core/board.ts` | `ImageSrcSet` 의미 확장 주석(문자열 = dataURL 또는 Storage키/서명URL). 타입은 동일(string) |
| `core/share-adapter.ts` | `ShareAdapter` 확장 + **`SupabaseShareAdapter` 신규** + `LocalShareAdapter` stub 보강 |
| `core/srcset.ts` | **`attachSrcSets`가 srcs 채운 직후 일반 이미지의 `item.src=''`로 비움(P1#4, 코드 반영 완료)**. crop·GIF 경량본 생성·Storage 키 치환·`assertNoDataUrls` 가드는 SupabaseShareAdapter 후처리(M3) |
| `main.ts` | `shareWebLink`에 signIn + 허용 이메일 UI + SupabaseShareAdapter 주입 |
| `viewer/main.ts` | `loadHashBoard`에 auth 분기 + LoadResult 에러 UI + 서명URL 치환 |
| `viewer.html` | OAuth 콜백/해시 복원 처리 |
| `.env`(신규) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`(공개돼도 RLS가 보호) |
| `package.json` | `@supabase/supabase-js` 추가 |

## 13. 구현 마일스톤

- **M1 인프라**: (사용자) Supabase 프로젝트 생성 → 스키마/RLS SQL 적용 → 구글 OAuth 설정 → `.env` 키.
- **M2 Auth**: SupabaseShareAdapter 골격 — signIn/signOut/getCurrentUser + 세션 복원.
- **M3 업로드**: ①`boards.insert(status='uploading')` 선행 → ②Storage 분리 업로드(P1#4 후처리: crop·GIF 경량본·키 치환·가드) → ③`status='ready'`. try/catch 보상삭제 + 고아 GC cron. **보드 삭제 UI + Storage cascade(P1#3) 이 단계 필수**.
- **M4 로드**: RLS select + 서명URL 치환 + 뷰어 에러 UI(로그인/권한/만료).
- **M5 작성자 UI**: 공유 모달(허용 이메일 입력·공개 토글·만료).
- **M6 운영·검증**: health ping **2개 이중화 + 실패 알림**(P1#7). **2계정 e2e**: 허가=열림 / 미허가=거부 / 만료=거부 / `allowlist` 직접 select 0행(P2#8) / 비공개 전환 후 Storage 키 직접 접근 차단(P2#10). egress 80% 알림 확인.

## 14. 미결정 — 사용자 입력 필요

1. **Supabase 프로젝트 생성·키 발급** (계정 작업은 사용자만 — 제가 대신 못 함)
2. **뷰어 배포 도메인** (`getShareUrl` 베이스). 후보: Cloudflare Pages(무료·대역폭 무제한). 정해야 OAuth redirect URL도 등록 가능
3. **로그인 수단**: 구글만? 매직링크도 함께?
4. **'중' 수준(비번/만료) 병행 여부** — 허용목록만으로 충분한지, 비번도 옵션 제공할지
5. ~~**orig 저장 정책**~~ → **결정됨(P1#3): 기본 미저장(medium 재사용)**. "고화질 보존" 명시 옵트인 시에만 orig 업로드(잔여 용량 표시 후 확인)

## 15. 보안 체크리스트(구현 시 필수)

- [ ] 모든 표 RLS enable(anon key 공개 전제 — RLS가 유일 방어선)
- [ ] Storage 버킷 비공개 + 서명 URL만(공개 URL 금지)
- [ ] 서명 URL: medium 7d 장수명 + `Cache-Control: max-age=604800`, orig 온디맨드 1h(P1#6) — 전체 1h 단일 정책 금지
- [ ] 허용목록 검증은 `is_allowed()` SECURITY DEFINER로 단일화 — `email_verified: true` + `aud: 'authenticated'` 내부 검증(P1#1), 인라인 `exists(...)` 직접 비교 금지
- [ ] 허용목록 이메일 = `auth.jwt() ->> 'email'` 비교 시 **소문자 정규화** 양쪽
- [ ] Storage `storage.objects`도 `is_allowed()` SELECT RLS 적용 + board_id 고엔트로피(P1#2)
- [ ] 업로드는 insert(status='uploading')→Storage→ready 순서 + 보상삭제·고아 GC(P1#5)
- [ ] 보드 수정/삭제는 `owner = auth.uid()`만
- [ ] anon key만 클라이언트 노출(service_role 키는 절대 클라이언트에 넣지 않음)
- [ ] 만료 검사 RLS에 포함(클라이언트 검사만으로 불충분)

## 16. 적대검증(5라운드) 결과 — 착수 전 필수 선결

> 2026-06-20, 5라운드 적대적 검증(31 에이전트, 5각도×5R, 매라운드 Codex 자문, 누적 179 raw findings) 종합.
> **판정: 조건부 No-Go** — 방향(Supabase Free + RLS + 허용목록 + 서명URL)은 타당하나, 그대로 구현하면 (A) 접근제어가 실제로 뚫리고 (B) 무료 한도가 의도한 '정지'를 넘어 '복구 불가 데드락'이 된다. 아래 **P1 7건은 전부 출시 차단(blocker)**.
> 검증 한계: 종합 에이전트 입력이 R1 도중 잘려(스크립트 slice 제한) R2~5 본문·Codex 자문 원문이 종합에 미반영. 단 R1 37건 + 코드 대조로 결함이 **2개 근본원인 클러스터(보안 방어선 / 용량·egress)** 로 강하게 수렴. 정량 수렴곡선은 재실행(전체 라운드 JSON 파일 저장) 시 측정 권장.

### P1 (출시 차단)
1. **RLS가 미검증 email 클레임 신뢰 → 허용목록 우회**(보안)
   - 공격: 매직링크/임의 provider로 `victim@allowed.com` 가입 → 메일 확인 없이 얻은 email 클레임으로 RLS 통과 → jsonb(Storage 키 전체) 유출.
   - 수정: RLS를 `is_allowed(board_id)` **SECURITY DEFINER** 함수로 단일화 — 내부에서 `(auth.jwt()->>'email_verified')::boolean is true AND auth.jwt()->>'aud'='authenticated'` 확인 후 `lower(email)` 매칭. 매직링크는 confirm 완료 세션만 신뢰, 민감 보드는 구글 OAuth 한정.
2. **Storage 보호를 클라이언트 로직에 위임 → anon key로 직접 다운로드**(보안)
   - 공격: anon key로 supabase 클라이언트 생성 → `{board_id}/{image_id}/medium.webp` 키 구성 → `createSignedUrl` 직접 호출 → DB가 0행이어도 이미지 유출.
   - 수정: 6절 옵션B 삭제(완료). `storage.objects` 강제 SELECT RLS + board_id를 12hex(48bit)→고엔트로피(UUID 전체/22자 base62)로 확대.
3. **무손실 orig 1GB 조기소진 → 복구불가 데드락**(비용)
   - 80장×2.5MB ≈ 220MB → 보드 4~5개로 1GB 소진. 카드 미등록이라 정지만, 푸는 길은 수동삭제/Pro뿐 = 데드락.
   - 수정: **orig 기본 미저장**(공유는 medium만, 라이트박스도 medium 재사용, orig는 명시 옵트인). 업로드 전 용량 사전가드+잔여 표시. 보드 삭제 UI+cascade를 **M3 필수로 승격**.
4. **orig src가 jsonb에 잔류 → DB 폭발+egress**(비용, 코드-문서 모순)
   - 문서 8절은 'src 제거'라 했으나 실제 `srcset.ts attachSrcSets`는 src를 안 지우고(line 105), crop/GIF는 srcs조차 없음. base64 +33%로 crop/GIF 많은 보드는 jsonb 1행이 수십MB.
   - 수정: SupabaseShareAdapter 후처리에서 (a) srcs 채운 뒤 `it.src` 삭제/키 치환 (b) crop·GIF도 경량본 업로드 후 키 치환. insert 전 `data:` 접두 가드.(8절 반영 완료)
5. **업로드 실패 orphan 롤백 부재**(비용)
   - Storage는 트랜잭션 밖 → 루프 중간/insert 실패 시 고아 객체, 재시도가 새 id로 누적 → 보드 다 지워도 회수 불가.
   - 수정: 순서 역전 ①`boards.insert(status='uploading')` → ②Storage 업로드 → ③`status='ready'`. try/finally 보상삭제. 재업로드는 기존 board_id upsert. 고아 GC 배치(cron).
6. **서명URL 1h 토큰 회전 → 캐시 미적중 재과금 → 5GB 조기소진**(비용)
   - 토큰이 매번 달라 1h마다 재다운로드. 10명×100장×3회/일 ≈ 일 750MB+ → 4~5일에 5GB 돌파, 정지 시 권한 통과해도 바이너리 0.
   - 수정: medium은 **장수명 서명URL(예 7d)+Cache-Control**, orig만 온디맨드 단축. 가능하면 이미지를 egress 무제한 **Cloudflare**로 이전(Supabase는 메타/권한만). egress 80% 알림.
7. **health-ping 단일장애점·무알림 → 자동정지**(비용)
   - 1주 비활성 정지인데 단일 cron은 지연/스킵/60일 자동비활성, 실패 경보 없음 → PAUSED를 아무도 모름.
   - 수정: ping 제공자 2개+ 이중화 + 죽은 ping 감지 알림. 중요 보드는 자기완결 HTML(`share-export.ts`)로도 이중 보관.

### P2
8. **`board_allowlist` for all 단일정책** → 정상 뷰어 차단(기능파괴) 또는 느슨한 SELECT 시 초대 이메일 PII enumeration. 수정: SELECT는 소유자 전용 별도 정책, 검증은 `is_allowed()` 함수로(호출자 RLS 우회·내부 검증).
9. **서명URL 유출 + localStorage 자동세션** → URL/공용PC 접근제어 무력화. 수정: 용도별 차등 만료(medium 길게+Cache-Control / orig 온디맨드 단축 — P1#6과 분리 적용), 공용PC signOut UI, `Referrer-Policy:no-referrer`·`Cache-Control:no-store`.
10. **is_public 영구노출 + DB/Storage RLS 비대칭** → 비공개 전환·만료 후에도 이미지 잔존 접근. 수정: is_public도 고엔트로피+경고 UI, storage 정책을 DB와 단일소스 동기화, 만료 시 객체 실제 삭제/키 회전.

### 기각(오탐 2건)
- "genId 8자 충돌": 현행 **12자**(과거 bug-io 수정 완료). 단 '공개/예측 enumerate엔 48bit 부족 → 고엔트로피화'는 유효(P1#2에 흡수).
- "매직링크가 '항상' 미검증 row 생성": 설정 의존이라 '항상'은 과함. 단 RLS `email_verified` 미검사 구조 결함은 P1#1로 유지.

### 종합 — 수정 후 재검토
P1 7건 해소 → 재검증(전체 라운드 JSON 저장)으로 No-Go→Go 판정. M3에 보드삭제/cascade 승격, M6 e2e에 'allowlist 직접 select 0행'·'비공개 전환 후 키 접근 차단' 케이스 추가.
```
