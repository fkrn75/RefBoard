# RefBoard — Codex 인계(Handoff) 문서

> **목적**: 이 프로젝트를 **Codex(또는 다른 에이전트)가 맥락 없이 콜드 스타트로 이어받아 마무리**하기 위한 자기완결 인수인계 문서.
> 작성 2026-06-27 (Claude Code 세션 토큰 소진으로 인계). 진행의 단일 출처(SSOT)는 여전히 **[`체크리스트.md`](../체크리스트.md)** — 작업하면서 거기 체크박스를 갱신할 것.
> 이 문서는 "온보딩 + 절대 규칙 + 시작점"이고, **남은 작업의 상세·파일:라인 근거는 `체크리스트.md`의 Phase 7**에 있다(중복 복사하지 않음).

---

## 0. 30초 요약

- **RefBoard** = [PureRef](https://www.pureref.com/) 클론(무한 캔버스 레퍼런스 이미지 보드) **+ 웹 링크 공유**(모바일/타 PC 읽기 전용 뷰어).
- 개인 포트폴리오 프로젝트. 한국어 프로젝트(주석·문서·UI 전부 한국어).
- **MVP·v1.0 기능은 거의 완료**. 남은 건 ① **Phase 7 개선 백로그(견고성/성능/정리/폴리시, 전부 미착수)** ② Phase 0~6의 자잘한 🟢 확장 항목.
- 데이터 손상 버그는 **이미 근본 수정·검증 완료**(커밋 `84c61ac` + `40c2052`). 그 방어선(매직바이트 검증)은 **건드리지 말 것**(§4).
- **마무리 = `체크리스트.md`의 미체크(`[ ]`) 항목을 우선순위대로 구현**. 권장 시작점은 **Phase 7.1 견고성 묶음**(§6).

---

## 1. 스택 & 아키텍처

| 항목 | 내용 |
|---|---|
| 언어/번들러 | TypeScript (strict) + Vite 6 |
| 렌더링 | **PixiJS v8** (WebGL) — 무한 캔버스, 수백 장 대응(가상화) |
| 데스크탑 셸 | **Tauri 2** (Rust) — `app/src-tauri/` |
| 웹 공유 백엔드 | **Supabase** (Auth + Postgres RLS + 비공개 Storage "boards") |
| 배포 | GitHub `fkrn75/RefBoard` → **Cloudflare Pages 자동배포** (`refboard-e0m.pages.dev`), push 시 재배포 |
| 테스트 | **없음(0건)** — Phase 7.1의 첫 작업이 vitest 도입 |
| 린터 | **없음** — ESLint/Prettier 미도입(Phase 0 잔여). 코드 스타일은 **기존 코드 관습을 따를 것** |

**핵심 설계**: 에디터(`index.html`/`src/main.ts`)와 웹 뷰어(`viewer.html`/`src/viewer/main.ts`)가 **같은 코어 `app/src/core/`를 공유**한다.
⚠️ 따라서 **`core/` 한 곳을 고치면 에디터와 뷰어 양쪽에 영향**이 간다. 직렬화 스키마도 로컬 `.refb`와 공유 보드가 동일(뷰어 `deserialize` 호환).

---

## 2. 빠른 시작 (Windows / PowerShell 환경)

```powershell
# 모든 명령은 app/ 안에서. (repo 루트는 C:\Users\hong\RefBoard, 코드는 그 아래 app/)
cd C:\Users\hong\RefBoard\app
npm install
npm run dev          # http://localhost:1420  (에디터 = /, 뷰어 = /viewer.html)
```

```powershell
# 검증(작업 후 반드시):
npm run build        # = tsc && vite build && node scripts/stamp-sw.mjs  ← 타입+빌드 동시 검증
npm run preview      # 빌드 결과 로컬 서빙

# 데스크탑(Tauri) — npm script엔 없지만 CLI 설치돼 있음. app/에서:
npx tauri dev        # src-tauri = app/src-tauri
npx tauri build
```

- **환경 주의**: Windows. PowerShell 기본. Python 필요 시 `py -3`(PATH의 `python`은 Store stub이라 작동 안 함).
- dev 서버 포트 **1420**(고정, strictPort — Tauri devUrl과 일치해야 함).

---

## 3. 저장소 구조 / 코드 맵

```
RefBoard/
  체크리스트.md         ★ 진행 SSOT (Phase 0~7, 미체크 항목이 곧 할 일)
  기능명세서.md         PureRef 조사 + 기능 명세(기획 근거)
  README.md            실행법 + 전체 단축키표
  docs/                설계·감사 리포트 (아래 §7)
  app/
    package.json       scripts: dev / build / preview
    index.html         에디터 진입점        viewer.html  뷰어 진입점
    public/sw.js       뷰어 PWA 서비스워커(자동버전=stamp-sw.mjs)
    scripts/stamp-sw.mjs  빌드 시 SW 버전 스탬프
    src/
      main.ts          ★ 에디터 입력 배선 2266줄(선택/이동/줌/팬/드롭/단축키/runAction) — God-file, 분리 후보(7.3)
      core/            데스크탑·뷰어 공유 코어 (~45 모듈)
        board.ts       보드 상태 모델(SSOT) · serialize/deserialize
        scene.ts       PixiJS 렌더러 · 카메라(applyCam) · 노드(이미지/노트/드로잉) · AABB · rebuild
        selection.ts gizmo.ts pack.ts crop.ts zorder.ts align.ts grid.ts snap.ts group.ts
        history.ts autosave.ts recent.ts recent-picker.ts
        io.ts refb.ts  .refb(ZIP=fflate) 저장/열기 + 매직바이트 검증(§4)
        keymap.ts command-palette.ts toolbar.ts settings-panel.ts theme.ts
        style-control.ts opacity-control.ts eyedropper.ts export-image.ts
        minimap.ts virtualize.ts downscale.ts srcset.ts
        share-adapter.ts share-export.ts supabase.ts supabase-share.ts share-dialog.ts board-manager.ts
        tauri-bridge.ts
      viewer/          뷰어 전용: main.ts touch.ts lightbox.ts lazyload.ts board-meta.ts pwa.ts
    src-tauri/         Tauri 2 셸(Rust) · tauri.conf.json · 윈도우 모드 커맨드(set_window_opacity 등)
```

상세 역할표는 `체크리스트.md` 맨 끝 "부록 — 현재 코드 맵" 참조.

---

## 4. ⚠️ 절대 규칙 / 깨지 말아야 할 불변식

1. **git 커밋 아이덴티티 — 공개 repo는 반드시 `fkrn75@gmail.com`.**
   - repo 로컬 `user.email`이 이미 `fkrn75@gmail.com`으로 설정돼 있음(전역 config는 회사메일이라 분리됨). 커밋 전 `git config user.email` 확인. **전역/회사 메일로 커밋 금지.**
   - push 대상: `github.com/fkrn75/RefBoard`. push하면 Cloudflare Pages가 자동 재배포된다 → **사용자가 명시 요청할 때만 commit/push**.

2. **데이터 손상 방어선을 건드리지 말 것** (커밋 `84c61ac`+`40c2052`로 근본 수정 완료·검증됨).
   - 근본 원인이었던 것: 클라우드 보드의 빈 `src=''`를 `fetch('')` → CF SPA fallback HTML(`image/png`로 위장)을 `.png`로 저장 → 확장자만 믿고 dataURL로 둔갑 = 손상.
   - **교훈/불변식: content-type·확장자를 믿지 말고 파일 시그니처(매직바이트)/디코드 가능 여부로만 이미지 판별**. `refb.ts`의 `looksLikeImageBytes`/`sniffImageMime`, 디코드 가드 `canDecodeImage`가 그 방어선. 리팩터 시 이 검증을 우회/제거하면 손상 재발.

3. **`core/`는 에디터·뷰어 공유** — 한 곳 수정이 양쪽에 반영됨. 직렬화 스키마 변경 시 하위호환(구버전 `.refb`·구버전 공유 보드 로드)을 깨지 말 것.

4. **AABB는 `natural×scale`로 일반화**되어 있다(이미지·텍스트·드로잉 공통). 새 노드 타입/정렬/패킹 손볼 때 이 규약 유지.

5. **이미 양호 → 굳이 손대지 말 것**(Phase 7 감사가 "제외"로 판정):
   - strict 타입(`@ts-ignore` 0건, `as any`는 `eyedropper.ts` 6건으로 격리), XSS 방어(사용자 데이터 전부 `textContent`),
   - perf 일부 이미 해결: `applyCam` rAF 코얼레싱 · `contentBounds` 미니맵 조기종료 · `scene.rebuild` `Promise.all`.

---

## 5. 현재 상태 & 작업 경위

### 5.1 git 상태 (인계 시점, 2026-06-27)
- 브랜치 **`main`**, **origin/main과 동기화됨**(push 완료). working tree 깨끗(미커밋 0).
- 최근 커밋:
  ```
  22d6431 docs: Codex 인계 문서 + Phase 7 개선 백로그 정리   ← 이 인계 문서
  40c2052 fix: 공유 데이터 손상 origin 근본 차단 (.refb 매직바이트 검증)
  84c61ac fix: 공유 데이터 손상 근본 차단 (디코드 검증 3중 가드)
  07826ab fix: 불러온 보드 재공유 시 원본 이미지 손실 (attachSrcSets)
  8fb34a1 feat: 내 공유 보드 열기/편집 불러오기 (관리 패널)
  ```

### 5.2 작업 경위 타임라인 (왜 지금 이 상태인지)
- **기획**: `기능명세서.md`로 PureRef 조사 → 설계 확정 — Tauri 2 + PixiJS + **`core/` 공유 엔진** · `.refb` ZIP 포맷 · 웹공유=클라우드 업로드→링크→모바일 뷰어(**킬러 기능**).
- **Phase 1 (캔버스 코어 MVP)**: 무한 캔버스 · 가져오기(드롭/붙여넣기/파일) · 선택 · 이동 · 자동 패킹(Skyline) · `.refb` 저장/열기 · Undo/Redo.
- **Phase 2 (편집 도구)**: 변형 기즈모 · 비파괴 크롭 · 정렬/분배/정규화 · z순서 · 그룹 · 투명도/잠금 · 그리드/스냅 · 텍스트 노트 · 드로잉 · 색 스포이드.
- **Phase 3 (파일·내보내기)**: `.refb` ZIP · IndexedDB 자동저장/크래시 복구 · 내보내기(PNG/JPG/BMP, 씬/선택/개별) · 최근 파일.
- **Phase 4 (Tauri 셸)**: 윈도우 모드(항상위/아래·클릭스루·불투명도·타이틀바·캔버스잠금) · 테마 · 재바인딩 단축키 · 커맨드 팔레트 · 대량 이미지 가상화.
- **Phase 5 (웹 공유 — 차별점)**: **Supabase 실배포**(`refboard-e0m.pages.dev`, CF Pages 자동연동) · 업로드/단축링크 · 읽기전용 뷰어 · 라이트박스 · PWA · 다중해상도(thumb/medium WebP) · 권한(공개/만료/이메일).
- **Phase 6 (품질·마감)**: **버그 감사 2회** — 06-18 팀오케 59건(→24 수정) · 06-21 전수 9건(→전건). 성능(applyCam rAF 코얼레싱 등) · 접근성 · README 단축키표.
- **2026-06-21 P1 기능 배치**(`5cb8b6a` 등): 중앙정렬 · 면적 정규화 · 개별 내보내기(BMP) · 항목 순회 · 스포이드 · 최근 파일 UI · 기준별 격자 정렬.
- **2026-06-26 공유 왕복 UX + ★데이터 손상 근본 수정**(`84c61ac`+`40c2052`): 클라우드 보드 재공유 시 `src`가 손상되던 문제를 **매직바이트 검증**으로 차단(상세 §4-2). 시크릿창 실증·검증 완료.
- **2026-06-26 개선 백로그 4차원 감사** → **2026-06-27 `체크리스트.md` Phase 7로 통합**(17항목, 전부 미착수).
- **2026-06-27 이 인계 문서 작성**(`22d6431`) — Claude Code 토큰 소진으로 Codex 인계.

> 더 깊은 근거: Phase별 상세=`체크리스트.md`, 감사=`docs/bug-audit-2026-06-21.md`·`docs/bug-audit-phase6-2026-06-18.md`, 공유 설계=`docs/share-backend-design.md`.

---

## 6. 남은 작업 = `체크리스트.md`의 미체크 항목

전체 상세(파일:라인 + 처방 + 노력 추정)는 **`체크리스트.md` Phase 7**에 정리돼 있다. 여기엔 **첫 작업 묶음만** 요약한다.

> ⚠️ Phase 7의 🔴🟠🟡는 **그 감사 자체 기준**(Phase 0~6의 P0/P1/P2와 별개): 🔴 최우선(견고성) · 🟠 중간(성능/접근성/정리) · 🟡 폴리시.

### ▶ 권장 시작점: **Phase 7.1 견고성 묶음** (한 번에, 손상수정의 연장선)

1. **vitest 도입 → 테스트 0건 해소**(최대 부채). 치명 버그가 전부 *순수 로직 불변식*이라 브라우저 없이 단위테스트 가능한데 회귀가드가 0이다. 첫 스위트 ROI 순서:
   `looksLikeImageBytes`/`canDecodeImage` → `serialize↔deserialize` 왕복(+구버전/손상 입력) → `align`/`pack` AABB(natural×scale) → `keymap` combo 정규화.
2. **`deserialize` 스키마 검증 부재** (`board.ts:124`) = 크래시 클래스. 지금은 `JSON.parse(json) as BoardState`만, `io.ts`는 `schema` 접두사만 검사("io.ts가 검증한다"는 주석과 실제가 **계약 불일치**). items 비배열·camera 누락 시 `restore()`(`main.ts:581`)·`scene.rebuild`가 터지고 NaN 전파. **검증 헬퍼 1개**로 restore·viewer(`viewer/main.ts` `isValidBoard`)·recovery·lastSession을 일괄 가드.
3. **`scene.rebuild` `Promise.all`→`allSettled`** (`scene.ts:350`). 이미지 1장 디코드 실패가 보드 전체 로드를 reject시킴. `addImage`에 빈/손상 src 플레이스홀더 폴백도 추가.
4. **조용한 실패 가시화**(데이터 손실을 사용자가 모름). autosave quota 초과가 `console.warn`만 / `setLastSession`·`beforeunload` 빈 catch(`recent.ts:83`, `main.ts:271`) / `handleUpload` try-catch 부재 / floating promise(`void restore(last)` `main.ts:1321`, `void scene.addNote()` `1357`) / 업로드 보상삭제 best-effort 삼킴(`supabase-share.ts:209`). → 빈 catch에 최소 `console.warn` + 핵심 경로 토스트.

### 그다음(토큰/노력 대비 효과 큼)
- **7.3 빠른 손질**: 상태바 "커서" 좌표가 영구 "—"(죽은 UI, `toolbar.ts`에 칸 있는데 `updateStatus({cursor})` 호출 0건 — `main.ts:617` pointermove에서 `screenToWorld`→`updateStatus`).
- **7.2 정리**: 죽은 코드 삭제(`share-export.ts` 133줄 전체 미사용, `viewer/lazyload.ts` 전체, `setupInstallPrompt` 미배선, 미사용 export ~27건) · DRY/매직상수 → `constants.ts`(z-index `10000`×5, `4096`×2, 줌범위 `0.05/20`×3 등).

### Phase 7.2 나머지(성능·접근성) / 7.3 나머지
- 드래그 핫패스 O(m×n)(`main.ts:814`) · import 직렬(`main.ts:2185`) · pack 메인스레드 O(25·n²) Worker화(`pack.ts`) · srcset 3회 디코드(`srcset.ts:60`) · 에디터 모달 5종 포커스 트랩 없음 · 에디터 터치 제스처 전무 · 공유 진행률 UI · prompt()/confirm()→모달 · `main.ts` 2266줄 점진 분리. ← 전부 `체크리스트.md` Phase 7.2/7.3에 파일:라인 있음.

### Phase 0~6 잔여(대부분 🟢 확장, 선택적)
- 0: ESLint/Prettier, npm audit 2건. · 4: 릴리스 빌드/서명, 오버레이 모드. · 5: 공유 비밀번호, 재업로드 같은 링크, 실시간 동기화, **만료안내화면 RPC는 코드 완료·라이브 SQL 사용자 실행 대기**. · 6: 다국어, 인앱 도움말. (전부 `체크리스트.md`에 `[ ]`로 있음.)

---

## 7. 참고 문서 (repo 내)

| 파일 | 용도 |
|---|---|
| `체크리스트.md` | ★ 진행 SSOT. 미체크 항목 = 할 일. **작업하면 여기 체크박스 갱신** |
| `기능명세서.md` | 기능 근거/기획 |
| `README.md` | 실행법 + 전체 단축키표(SSOT는 `keymap.ts`) |
| `docs/share-backend-design.md` | 공유 백엔드(Supabase) 설계 SSOT |
| `docs/bug-audit-2026-06-21.md`, `docs/bug-audit-phase6-2026-06-18.md` | 과거 감사 리포트 |
| `docs/supabase-setup-guide.md` | Supabase 셋업 |

---

## 8. 작업 루프(권장)

1. `체크리스트.md`에서 다음 미체크 항목 선택(우선 7.1 묶음).
2. 구현. 코드 스타일은 **주변 기존 코드 관습**을 따른다(한국어 주석).
3. **검증**: `cd app && npm run build`(tsc+vite 통과 0 에러) → 필요시 `npm run dev`로 동작 확인.
4. `체크리스트.md` 해당 항목 `[ ]`→`[x]`(또는 `[~]`) 갱신.
5. 커밋·푸시는 **사용자 요청 시에만** — 구체 절차는 §9.

---

## 9. Git 커밋·푸시 실전 절차 (복붙용)

> 환경: Windows / PowerShell. repo 루트 = `C:\Users\hong\RefBoard`(코드는 그 아래 `app/`, **git 명령은 repo 어디서나 가능**).

```powershell
cd C:\Users\hong\RefBoard

# 1) 아이덴티티 확인 — 공개 repo는 반드시 fkrn75@gmail.com (전역 config는 회사메일이라 분리됨)
git config user.email          # 기대값: fkrn75@gmail.com
# 비어있거나 다르면 (repo 로컬에만 설정):
# git config user.email "fkrn75@gmail.com"
# git config user.name  "fkrn75"

# 2) 스테이징 — 한글 파일명(체크리스트.md·기능명세서.md) 인코딩 이슈 회피 위해 -A 권장
git add -A
git status --short             # 의도한 파일만 올라갔는지 반드시 확인

# 3) 커밋 — 멀티라인은 PowerShell single-quote here-string (@'...'@), 닫는 '@는 반드시 컬럼0
git commit -m @'
<타입>: <한 줄 요약>

- 변경 요점 1
- 변경 요점 2
'@

# 4) 푸시 = Cloudflare Pages 자동 재배포 → 사용자 확인 후에만
git push origin main
```

**커밋 타입 관습**(기존 로그 따름): `feat:` 기능 · `fix:` 버그 · `docs:` 문서 · `refactor:` 리팩터 · `chore:` 잡무. 메시지는 한국어.

**주의/함정**:
- **푸시 = 배포**: push하면 `refboard-e0m.pages.dev`가 자동 재배포된다. `app/` 코드 변경이면 사이트에 실제 반영, 문서(`docs/`·`*.md`)만이면 사이트 동작은 동일. **무조건 사용자 확인 후 push.**
- `.gitignore`에 `node_modules`·`dist`·`src-tauri/target`이 있음 → 빌드 산출물은 안 올라감. 그래도 push 전 `git status`로 대용량/의도외 파일 점검.
- "`LF will be replaced by CRLF`" 경고는 Windows 줄바꿈 정규화로 **무해**(무시).
- 한글 파일명을 경로 인자로 직접 주면(`git add 체크리스트.md`) 셸 인코딩으로 깨질 수 있음 → `git add -A`가 안전.
- **커밋 전 검증**: `cd app && npm run build`로 tsc+vite 0 에러 확인 후 커밋(린터·테스트가 없으므로 빌드가 1차 안전망).
- Codex CLI는 git repo 안(여기 해당)에서 실행하면 됨 — `--skip-git-repo-check` 불필요.

---

## 10. 후속 보완 작업 (2026-06-27 Claude 검수에서 발견)

> 커밋 `97db47c`(Phase 7.1 + 7.2)를 검수한 결과 **합격**: `npm run test` 11/11 · `npm run build` 0 에러 · 핵심 불변식(매직바이트 방어선·undo aliasing 없음·구버전 `.refb` 하위호환) 전부 OK.
> 아래 후속 보완은 코드로 반영 완료. 현재 상태를 기준으로 적어둔다.

### 10.1 [x] 클라우드 보드 load도 `deserialize` 검증 적용 — 검증 비대칭 해소
- `app/src/core/board.ts`에 `parseBoardState()`를 분리해 object 경로를 직접 검증하고, `app/src/core/supabase-share.ts`의 클라우드 로드도 그 검증을 통과하도록 맞췄다.
- `board.test.ts`에 object 직접 검증 케이스를 추가해 Supabase jsonb 경로를 회귀 가드했다.

### 10.2 [x] 노트/드로잉 rebuild 실패도 가시화
- `app/src/core/scene.ts`의 복구 실패 플레이스홀더를 아이템 공통으로 바꿔서, 이미지뿐 아니라 노트/드로잉도 누락 대신 화면에 남도록 했다.

### 10.3 [x] `mapWithConcurrency` 계약 명확화
- `app/src/core/concurrency.ts`는 `mapWithConcurrency()` 하나만 남기고, 실패는 호출자가 직접 다루는 fail-fast 계약임을 유지한다.

### 10.4 [x] `mapWithConcurrencySettled` 미사용 해소
- settled 변형은 제거했다. 범용 유틸은 `mapWithConcurrency()` 하나만 남기고, 테스트도 그 계약만 검증한다.

### (참고·경미) 그 외
- `board.ts`의 `board.canvas` 부분검증 — `shareId?`/`sharePublic?` 미검증(표시용, 크래시 클래스 아님). 여유 있으면 같이.

### 작업 중 유지할 불변식 (재확인)
- **매직바이트 방어선**(`refb.ts` `looksLikeImageBytes`/`sniffImageMime`) 우회·약화 금지.
- `deserialize`는 **선택 필드를 요구하지 말 것**(구버전 `.refb` 하위호환). 기존 `board.test.ts` 전부 + 신규 케이스 통과 유지.
- 검증: `cd app && npm run test && npm run build` 0 에러. 커밋 아이덴티티 `fkrn75@gmail.com`(§9).

## 10.5 Codex 후속 반영 (2026-06-28)
- `main.ts`는 `note-editor.ts`와 `cursor-reporter.ts`를 분리해 입력 셸 일부를 덜어냈다. 아직 남은 분리는 `pointer-input`/`drawing-tool`/`action-dispatcher`/`share-io` 쪽이다.
- `share-dialog.ts`는 `dialog-shell.ts`를 재사용하도록 정리했다.
- `viewer/lightbox.ts`는 터치 팬/핀치 제스처를 받도록 바꿨고, `viewer/main.ts`의 만료 화면에는 재확인 버튼을 추가했다.
- `autosave.ts`는 BroadcastChannel + ts 비교로 다중탭 자동저장 충돌을 피하도록 보강했다.
- 최신 상태 기준 SSOT는 `체크리스트.md`다. 남은 건 7.3의 God-file 분리뿐이다.

## 11. ✅ 검수 회귀·후속 (2026-06-28) — 반영 완료

> 커밋 `a30f425`의 후속 검수에서 지적된 11.1~11.3 항목은 현재 코드에 반영되었다. 검증은 `cd app && npm run test` / `cd app && npm run build`로 다시 통과했다.

### 11.1 ✅ 기존 노트 재편집/삭제 복구
- `app/src/core/note-editor.ts`가 이제 Pixi 렌더 노드가 아니라 `board.items`의 `BoardNote`를 기준으로 편집 대상을 찾는다.
- 노트 삭제는 `main.ts`의 공용 제거 경로를 통해 `scene.removeItem()` + `board.items` 정리 + `normalizeZ()` + `syncZIndex()`까지 같이 처리한다.
- 회귀 방지용 `note-editor.test.ts`를 추가했다. 기존 노트 재편집과 빈 텍스트 삭제 둘 다 커버한다.

### 11.2 ✅ 공유 다이얼로그 Enter 확인 복구
- `dialog-shell.ts`에 옵션형 `onEnter` 처리를 넣었다.
- `share-dialog.ts`는 이제 Enter로도 `링크 만들기`를 확정한다.

### 11.3 ✅ 커서 팬 경로 reflow 완화
- 팬 시작 시 `host.getBoundingClientRect()`를 캐시하고, 드래그 중에는 그 값을 재사용한다.
- 포인터 이동 중의 불필요한 레이아웃 읽기를 줄였다.

### 11.4 ⚪ 추가 확인 사항
- `viewer`의 `forbidden` 화면 액션 버튼과 `lightbox` 스와이프 네비는 이번 수정 범위 밖이다.
- 필요하면 다음 손에서 UX 보완 후보로 다시 보자.

### 작업 중 유지할 불변식 (재확인)
- `as unknown as`/`as any`로 board 모델(`BoardItem`)과 Pixi 렌더 노드(`ItemNode`)를 혼동하지 말 것.
- 매직바이트 방어선(`refb.ts`)·`deserialize` 하위호환 유지(§4·§10).
- 검증: `cd app && npm run test` / `cd app && npm run build` 통과.

---

— 끝. 막히면 `체크리스트.md` Phase 7과 위 §4 불변식을 다시 확인할 것.
