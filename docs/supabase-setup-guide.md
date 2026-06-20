# RefBoard 웹 공유 — Supabase 셋업 가이드 (M1)

> 🧸 **처음이거나 용어가 어렵다면 → [아주 쉬운 설명 버전](supabase-셋업-쉬운설명.md) 을 먼저 보세요.** 이 문서는 정확한 기술 버전입니다.
>
> 대상: **사용자가 직접** 수행하는 인프라 작업(계정/프로젝트/키/OAuth는 대행 불가).
> 근거 설계: [`share-backend-design.md`](share-backend-design.md) v2(P1 7건 반영). 이 가이드의 SQL은 그 설계의 4·5·6절을 **실행 순서대로 통합**한 것이라 SQL Editor에 그대로 붙여넣으면 된다.
> 완료하면 `.env` 키 2개가 생기고, 코드(M2~)에서 `SupabaseShareAdapter`를 붙일 수 있다.

---

## 0. 체크리스트 (순서대로)

- [ ] 1. Supabase 프로젝트 생성 (**카드 미등록** — 무료/정지 보장)
- [ ] 2. API 키 2개 확보 → `app/.env`
- [ ] 3. SQL 1회 실행 (테이블 + RLS + `is_allowed()`)
- [ ] 4. Storage 버킷 `boards` 생성(**비공개**) + Storage RLS 실행
- [ ] 5. 구글 OAuth 설정 (Google Cloud + Supabase Auth)
- [ ] 6. 매직링크(이메일) 폴백 확인
- [ ] 7. health ping 이중화 (P1#7)
- [ ] 8. 2계정 e2e 검증

---

## 1. 프로젝트 생성

1. https://supabase.com → **Sign in**(GitHub 계정 권장) → **New project**.
2. 입력: Organization(없으면 생성, **무료 플랜**), Project name(`refboard`), DB Password(강하게 — Postgres 직접 접속용, 앱에선 안 씀), Region(가까운 곳: `Northeast Asia (Seoul)` 권장).
3. **결제 카드 등록하지 말 것.** 카드가 없으면 Pro 자동전환이 불가능 → 한도 초과 시 **요금 청구 없이 정지(capped)**. 이게 "넘으면 그냥 정지" 요구의 보장 장치다.
4. 생성에 ~2분. 완료까지 대기.

---

## 2. API 키 → `.env`

좌측 **Project Settings → API**(또는 **API Keys**)에서:

| 항목 | 위치 | 용도 |
|---|---|---|
| **Project URL** | `https://<ref>.supabase.co` | `VITE_SUPABASE_URL` |
| **anon public** | `anon` `public` 키 | `VITE_SUPABASE_ANON_KEY` (클라이언트 노출 OK — RLS가 방어) |
| ~~service_role~~ | secret 키 | ⚠️ **절대 클라이언트/`.env`(VITE_)·git에 넣지 말 것** |

`app/.env` 파일을 만들어(이미 `.gitignore`에 `.env` 포함됐는지 확인):

```env
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...(anon public 키)
```

> `VITE_` 접두만 브라우저 번들에 노출된다. anon 키는 공개돼도 안전(설계 전제) — 단 **service_role 키는 VITE_ 접두를 절대 붙이지 말 것**. 붙이면 관리자 권한이 번들에 박혀 RLS가 통째로 무력화된다.

---

## 3. DB 스키마 + RLS (SQL 1회 실행)

좌측 **SQL Editor → New query** 에 아래 전체를 붙여넣고 **Run**. (설계 4·5절 통합)

```sql
-- ===== RefBoard 공유 스키마 (M1) =====

-- 1) 테이블
create table boards (
  id          text primary key,                 -- 고엔트로피 ID(앱이 nanoid(22) 생성. P1#2)
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  data        jsonb not null,                   -- BoardState(items[].srcs는 Storage '키')
  status      text not null default 'uploading' check (status in ('uploading','ready')), -- P1#5
  is_public   boolean not null default false,
  password_hash text,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table board_allowlist (
  board_id text not null references boards(id) on delete cascade,
  email    text not null,                       -- 소문자 정규화해 저장(앱 책임)
  primary key (board_id, email)
);
create index on board_allowlist (email);

-- 2) is_allowed(): RLS 단일 게이트 — 미검증 email 클레임 신뢰 차단 (P1#1)
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

-- 3) RLS 활성화 + 정책
alter table boards          enable row level security;
alter table board_allowlist enable row level security;

-- 소유자: 자기 보드 전권
create policy boards_owner_all on boards
  for all using (owner = auth.uid()) with check (owner = auth.uid());

-- 읽기: (공개) 또는 (소유자) 또는 (is_allowed 통과) + 만료 안 됨
create policy boards_read on boards
  for select using (
    (expires_at is null or expires_at > now())
    and ( is_public or owner = auth.uid() or is_allowed(boards.id) )
  );

-- 허용목록: 소유자만 관리(SELECT도 소유자 한정 — 초대 이메일 PII enumeration 차단, P2#8)
create policy allowlist_owner on board_allowlist
  for all using (
    exists (select 1 from boards b where b.id = board_id and b.owner = auth.uid())
  );
```

> 실행 후 **Table Editor**에서 `boards`, `board_allowlist` 두 표가 보이고 각 표에 RLS 활성(자물쇠) 표시가 있으면 성공.

---

## 4. Storage 버킷 + Storage RLS (P1#2)

1. 좌측 **Storage → New bucket** → 이름 `boards`, **Public bucket 체크 해제(비공개)** → Create.
2. 다시 **SQL Editor**에서 아래 실행(버킷 생성 후라야 정책이 붙는다):

```sql
-- ===== Storage RLS (P1#2) =====
-- 읽기: board_id 폴더를 파싱해 boards_read와 '동일한' is_allowed()로 게이트.
-- (anon key가 공개라 '클라가 DB 확인 후 서명URL' 위임은 방어선이 아님 — 서버가 강제해야 한다.)
create policy storage_boards_read on storage.objects
  for select using (
    bucket_id = 'boards'
    and is_allowed((storage.foldername(name))[1])
  );

-- 쓰기/삭제: 해당 board 폴더의 '소유자'만(자기 보드에만 업로드)
create policy storage_boards_write on storage.objects
  for insert with check (
    bucket_id = 'boards'
    and exists (
      select 1 from boards b
      where b.id = (storage.foldername(name))[1] and b.owner = auth.uid()
    )
  );

create policy storage_boards_delete on storage.objects
  for delete using (
    bucket_id = 'boards'
    and exists (
      select 1 from boards b
      where b.id = (storage.foldername(name))[1] and b.owner = auth.uid()
    )
  );
```

> 이미지는 항상 **서명 URL(만료 포함)** 로만 받는다. 공개 URL은 쓰지 않는다.
> 경로 규약: `{board_id}/{image_id}/medium.webp` (+ thumb, orig는 옵트인 시).

---

## 5. 구글 OAuth (뷰어 로그인 1순위)

배포 도메인이 정해지지 않았다면 우선 **localhost로 설정 후 도메인 확정 시 redirect만 추가**하면 된다.

### 5-1. Google Cloud Console
1. https://console.cloud.google.com → 프로젝트 생성/선택.
2. **APIs & Services → OAuth consent screen**: External, 앱 이름·이메일 입력, Test users에 본인+테스트 계정 추가(게시 전엔 테스트 사용자만 로그인 가능).
3. **Credentials → Create Credentials → OAuth client ID** → Application type: **Web application**.
4. **Authorized redirect URIs** 에 Supabase 콜백 추가:
   ```
   https://<your-ref>.supabase.co/auth/v1/callback
   ```
5. 생성된 **Client ID / Client secret** 복사.

### 5-2. Supabase
1. 좌측 **Authentication → Providers → Google** → Enable.
2. 위 Client ID / Client secret 붙여넣기 → Save.
3. **Authentication → URL Configuration**:
   - **Site URL**: 개발 중 `http://localhost:5173`(뷰어 dev 포트에 맞게), 배포 후 실제 도메인.
   - **Redirect URLs**: `http://localhost:5173/**`, 배포 도메인 `https://<도메인>/**` 추가.

> ⚠️ OAuth 리다이렉트가 `#/b/<id>` 해시를 날릴 수 있다 → 코드(M2)에서 signIn 전 복귀용 id를 `localStorage`에 저장하고 콜백 후 복원한다(설계 10절).

---

## 6. 매직링크(이메일) 폴백

- 구글 계정이 없는 뷰어용. **Authentication → Providers → Email** 이 기본 활성.
- 무료 기본 메일은 발송량 제한·스팸 처리가 잦다 → 필요 시 **Custom SMTP**(예: Resend/Brevo 무료) 연결 권장.
- 보안: 매직링크는 **confirm 완료 세션만** 신뢰된다. RLS의 `is_allowed()`가 `email_verified`를 검사하므로(P1#1), 미확인 메일로는 허용목록을 통과하지 못한다. 민감한 보드는 구글 OAuth 한정 권장.

---

## 7. health ping 이중화 (P1#7 — 무료 정지 방지)

무료 프로젝트는 **1주 비활성 시 일시정지**된다. 단일 ping은 지연/스킵/무알림 위험 → **2개 이상**:

1. **GitHub Actions cron**(리포에 `.github/workflows/keepalive.yml`):
   ```yaml
   on:
     schedule: [{ cron: '0 0 * * *' }]   # 매일 09:00 KST
   jobs:
     ping:
       runs-on: ubuntu-latest
       steps:
         - run: curl -fsS "$URL/rest/v1/?apikey=$KEY" || exit 1
         env: { URL: ${{ secrets.SUPABASE_URL }}, KEY: ${{ secrets.SUPABASE_ANON_KEY }} }
   ```
   (실패 시 GitHub이 메일 경보 → "죽은 ping" 감지)
2. **cron-job.org**(백업, 다른 시간대): 같은 엔드포인트를 12시간 간격으로 핑.
3. 중요 보드는 기존 **자기완결 HTML 내보내기**(`share-export.ts`)로도 이중 보관(정지·장애 시에도 읽기 가능).

---

## 8. 검증 (2계정 e2e)

키·SQL·OAuth가 끝나면 M2~M6 구현 후 아래를 통과해야 한다(M6 게이트):

| 케이스 | 기대 |
|---|---|
| 허가 이메일로 로그인 | 보드 열림 |
| **미허가** 이메일로 로그인 | "권한 없음" 거부 |
| 만료된 링크 | "만료" 거부 |
| `board_allowlist` 직접 select(뷰어) | **0행**(소유자만, P2#8) |
| 비공개 전환/만료 후 Storage 키 직접 접근 | 차단(P2#10) |
| 미로그인 진입 | 로그인 유도 |

---

## 다음 단계 (코드 — 키 발급 후 내가 진행)

1~7 완료 후 알려주시면:
- **M2 Auth**: `SupabaseShareAdapter` 골격(signIn/signOut/getCurrentUser + 세션 복원)
- **M3 업로드**: `insert(uploading)` → Storage 분리 업로드(crop·GIF 경량본·키 치환·`assertNoDataUrls` 가드) → `ready` + 보상삭제/GC + 보드 삭제 UI
- **M4 로드**: RLS select + 차등 서명URL(medium 7d / orig 온디맨드) + 뷰어 에러 UI
- **M5 작성자 UI**: 공유 모달(허용 이메일·공개·만료·잔여 용량 표시)
- **M6 운영·검증**: ping 이중화 + 위 e2e

> `.env`의 **anon 키만** 공유해 주시면(service_role은 절대 금지) 코드 연동을 시작할 수 있습니다. 키를 채팅에 붙이기 꺼려지면, 제가 코드를 `import.meta.env.VITE_SUPABASE_*`로 작성해 둘 테니 키는 직접 `.env`에만 넣으셔도 됩니다.
