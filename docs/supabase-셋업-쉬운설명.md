# 🧸 Supabase 셋업 — 아주 쉬운 설명

> 이건 **어려운 말 하나도 없이** 따라만 하면 되는 버전이에요.
> 정확한 기술 버전은 [supabase-setup-guide.md](supabase-setup-guide.md)에 있어요(개발자용).

---

## 🤔 이게 다 뭐예요? (1분 이야기)

내 **사진 보드(RefBoard)** 를 친구한테 인터넷으로 보여주고 싶어요.
그러려면 두 가지가 필요해요:

1. 📦 **사진을 넣어둘 인터넷 창고** — 내 컴퓨터를 꺼도 친구가 볼 수 있게.
2. 💂 **문지기** — 아무나 못 들어오고, 내가 **초대한 친구만** 들어오게.

**Supabase(수파베이스)** 가 바로 이 *창고 + 문지기* 를 **공짜로** 빌려줘요.
우리가 할 일은 "창고를 빌리고, 열쇠를 받아서 나(클로드)한테 주는 것" 이게 거의 전부예요. 😊

---

## ⏱️ 준비물

- 인터넷 되는 컴퓨터
- 구글 계정 또는 GitHub 계정 (로그인용)
- 약 20~30분
- 💳 **신용카드 필요 없어요!** (오히려 등록하면 안 돼요. 아래에서 설명)

---

## 🗺️ 큰 그림 (딱 3개만 하면 돼요)

```
1단계  📦 창고 빌리기        ← 5분
2단계  🔑 열쇠 2개 복사해서 나한테 주기   ← 2분  ← 이게 제일 중요!
3단계  🪄 마법 주문 2개 붙여넣기 (창고에 선반·문지기 설치)  ← 5분
```

> 더 어려운 "구글로 로그인" 설정(4단계)은 **나중에 화면 보면서 같이** 하면 돼요.
> 우선 1·2·3단계만 해주세요!

---

## 📦 1단계: 창고 빌리기

1. 인터넷 주소창에 **supabase.com** 입력하고 들어가요.
2. 오른쪽 위 **초록색 버튼** (`Start your project` 또는 `Sign in`) 클릭.
3. **GitHub 또는 Google 로 로그인** 해요. (없으면 가입 — 무료예요)
4. **`New project`** (새 프로젝트) 버튼 클릭.
5. 칸 채우기:
   - **Name(이름)**: 아무거나. 예) `refboard`
   - **Database Password(비밀번호)**: 옆에 **`Generate a password`** 같은 버튼이 있으면 눌러서 자동으로 만들게 해요. 그리고 **메모장에 복사해 둬요** (지금은 안 쓰지만 혹시 몰라서).
   - **Region(지역)**: 목록에서 **`Northeast Asia (Seoul)`** 고르기. (우리나라랑 가까워서 빨라요)
   - 💳 **카드 입력 칸이 나와도 절대 넣지 마세요.** 카드를 안 넣으면, 공짜 용량을 다 쓰면 **그냥 멈추기만** 하고 **돈이 절대 안 나가요.** (이게 우리가 원하는 거예요!)
6. **`Create new project`** 클릭.
7. 🕐 **2분 정도 기다려요.** (창고를 짓는 중이에요. 빙글빙글 돌아가요)

✅ **성공 확인:** 화면에 표(dashboard)가 나오면 창고 완성!

---

## 🔑 2단계: 열쇠 2개 복사하기 ⭐ (제일 중요!)

이제 창고 **출입증 2개**를 찾아서 나한테 줄 거예요.

1. 화면 **왼쪽 맨 아래 톱니바퀴 ⚙️** (`Project Settings`, 설정) 클릭.
2. 그 안에서 **`API`** (또는 `API Keys`) 클릭.
3. 거기 두 개를 찾아요:

| 찾을 것 | 어떻게 생겼나 | 어떻게 하나 |
|---|---|---|
| **Project URL** | `https://어쩌고.supabase.co` | **복사** 📋 |
| **anon · public** | `eyJhbGci...` 로 시작하는 긴 글자 | **복사** 📋 |

4. 이 **두 개를 채팅창에 붙여넣어서 나한테 주세요.** 😊
   - 👍 이 두 개는 **남이 봐도 안전한 일반 출입증**이라 줘도 괜찮아요.

> 🚨 **빨간 경고 — 딱 하나만 조심!**
> 같은 화면에 **`service_role`** 이라고 적힌 키(`secret` 표시)도 있어요.
> 이건 **우리 집 마스터 만능열쇠** 라서 **절대로** 복사해서 주거나 어디 올리면 안 돼요.
> (도둑이 이거 하나면 다 가져가요. **anon public** 만 주세요!)

---

## 🪄 3단계: 마법 주문 2개 붙여넣기

창고 안에 **선반(사진 넣을 곳)** 과 **문지기(아무나 못 들어오게)** 를 설치할 거예요.
아래 글자들이 "설치 설계도(마법 주문)" 인데 — **무슨 뜻인지 1도 몰라도 100% 괜찮아요.**
라면 봉지 뒷면 보고 그대로 끓이는 거랑 똑같아요. 그냥 **복사 → 붙여넣기 → 실행** 만 해요.

### 🪄 주문서 1번 (선반 + 문지기 만들기)

1. 왼쪽 메뉴에서 **`SQL Editor`** (📄 종이에 연필 그림) 클릭.
2. **`New query`** (새 질문) 클릭.
3. 아래 회색 박스 글자를 **통째로 전부 복사** 해서, 빈 칸에 붙여넣기:

```sql
-- 선반(표) 만들기
create table boards (
  id          text primary key,
  owner       uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  data        jsonb not null,
  status      text not null default 'uploading' check (status in ('uploading','ready')),
  is_public   boolean not null default false,
  password_hash text,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table board_allowlist (
  board_id text not null references boards(id) on delete cascade,
  email    text not null,
  primary key (board_id, email)
);
create index on board_allowlist (email);

-- 문지기 규칙(초대 명단 확인 + 진짜 본인인지 확인)
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

-- 문지기 켜기
alter table boards          enable row level security;
alter table board_allowlist enable row level security;

create policy boards_owner_all on boards
  for all using (owner = auth.uid()) with check (owner = auth.uid());

create policy boards_read on boards
  for select using (
    (expires_at is null or expires_at > now())
    and ( is_public or owner = auth.uid() or is_allowed(boards.id) )
  );

create policy allowlist_owner on board_allowlist
  for all using (
    exists (select 1 from boards b where b.id = board_id and b.owner = auth.uid())
  );
```

4. 오른쪽 아래 **초록색 `Run`** (실행) 버튼 클릭. ▶️

✅ **성공 확인:** 초록색으로 **`Success`** 비슷한 글자가 나오면 성공! (빨간 글자가 나오면 캡처해서 나한테 보여주세요)

---

### 📦 주문서 2번 전에: 사진 박스 만들기

주문서 2번은 "사진 박스" 가 먼저 있어야 해요. 박스부터 만들게요.

1. 왼쪽 메뉴에서 **`Storage`** (📦 상자 그림) 클릭.
2. **`New bucket`** (새 박스) 클릭.
3. 이름: **`boards`** 라고 정확히 입력. (소문자!)
4. **`Public bucket`** 이라는 체크 표시가 있으면 **체크를 꺼요(비워둬요).** ← 중요! (아무나 못 보게)
5. **`Create`** (만들기) 클릭.

✅ **성공 확인:** `boards` 라는 박스가 목록에 보이면 성공!

---

### 🪄 주문서 2번 (사진 박스에도 문지기 붙이기)

1. 다시 왼쪽 **`SQL Editor`** → **`New query`**.
2. 아래를 통째로 복사 → 붙여넣기 → 초록색 **`Run`**:

```sql
-- 사진 박스 읽기: 초대 명단에 있는 사람만
create policy storage_boards_read on storage.objects
  for select using (
    bucket_id = 'boards'
    and is_allowed((storage.foldername(name))[1])
  );

-- 사진 넣기/지우기: 자기 보드 주인만
create policy storage_boards_write on storage.objects
  for insert with check (
    bucket_id = 'boards'
    and exists (select 1 from boards b where b.id = (storage.foldername(name))[1] and b.owner = auth.uid())
  );

create policy storage_boards_delete on storage.objects
  for delete using (
    bucket_id = 'boards'
    and exists (select 1 from boards b where b.id = (storage.foldername(name))[1] and b.owner = auth.uid())
  );
```

✅ **성공 확인:** 또 초록색 `Success` 가 나오면 끝!

---

## 🎉 여기까지 하면 끝!

**1·2·3단계** 를 다 했으면, **2단계에서 복사한 열쇠 2개** 를 나한테 주세요.
그럼 제가 RefBoard랑 창고를 연결하는 코드를 만들기 시작할게요. 💪

---

## 🙋 자주 막히는 곳

- **"카드를 넣으래요"** → 넣지 말고 건너뛰기/취소. 카드 없이도 무료로 다 돼요.
- **빨간 에러 글자가 나왔어요** → 당황 말고 그 화면을 **캡처해서** 채팅에 붙여주세요. 같이 고쳐요.
- **메뉴가 영어라 못 찾겠어요** → 화면 캡처해서 "어디 눌러요?" 물어보세요.
- **열쇠가 두 개 중 뭘 줘야 할지 모르겠어요** → `service_role`(빨강/secret) 빼고 **`anon` `public`** 이랑 **`URL`** 두 개만.

---

## 🔜 나중에 같이 할 것 (4단계 — 안 어려워요, 화면 보며 같이)

- **"구글로 로그인" 기능**: 친구가 구글 계정으로 신분 확인하고 들어오게 하는 설정.
  단계가 좀 많아서(구글 사이트 + Supabase 양쪽 설정), **화면 공유하듯 하나씩 같이** 하는 게 제일 빨라요.
- **창고 안 잠들게 하기**: 무료 창고는 1주일 안 쓰면 잠들어요. 자동으로 깨우는 알람을 제가 걸어둘게요. (사용자가 할 건 없어요)

> 이 두 개는 **1·2·3단계 다 끝나고** 천천히 하면 됩니다. 지금은 신경 안 써도 돼요! 😄

---

## 🧠 어려운 단어 사전 (안 외워도 됨)

| 어려운 말 | 쉬운 뜻 |
|---|---|
| Supabase | 사진 넣을 인터넷 창고 + 문지기 (무료 임대) |
| Project | 내가 빌린 창고 한 칸 |
| Key / 키 | 창고 출입증 |
| anon public | 남 줘도 되는 **일반 출입증** ✅ |
| service_role | 절대 남 주면 안 되는 **마스터 만능키** 🚨 |
| SQL | 창고에 선반·문지기 설치하는 "설계도 주문" |
| RLS | 명단에 있는 사람만 들여보내는 **문지기 규칙** |
| Storage / Bucket | 사진을 실제로 넣는 **박스** |
| allowlist | **초대 명단** (이 친구는 들어와도 됨) |
| OAuth | 구글 계정으로 **신분 확인하고 로그인** |
