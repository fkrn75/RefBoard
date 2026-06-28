# RefBoard — Codex 인계(Handoff) 문서

> **목적**: 이 프로젝트를 **Codex(또는 다른 에이전트)가 맥락 없이 콜드 스타트로 이어받아 마무리**하기 위한 자기완결 인수인계 문서.
> 작성 2026-06-27 (Claude Code 세션 토큰 소진으로 인계). 진행의 단일 출처(SSOT)는 여전히 **[`체크리스트.md`](../체크리스트.md)** — 작업하면서 거기 체크박스를 갱신할 것.
> 이 문서는 "온보딩 + 절대 규칙 + 시작점"이고, **남은 작업의 상세·파일:라인 근거는 `체크리스트.md`의 Phase 7**에 있다(중복 복사하지 않음).

---

## 0. 30초 요약

- **RefBoard** = [PureRef](https://www.pureref.com/) 클론(무한 캔버스 레퍼런스 이미지 보드) **+ 웹 링크 공유**(모바일/타 PC 읽기 전용 뷰어).
- 개인 포트폴리오 프로젝트. 한국어 프로젝트(주석·문서·UI 전부 한국어).
- **MVP·v1.0 기능은 거의 완료**. 남은 건 ① **Phase 7.3 main.ts God-file 분리** ② **Phase 7.5 잔여(P2/P3)** ③ Phase 0~6의 자잘한 🟢 확장 항목.
- 데이터 손상 버그는 **이미 근본 수정·검증 완료**(커밋 `84c61ac` + `40c2052`). 그 방어선(매직바이트 검증)은 **건드리지 말 것**(§4).
- **마무리 = `체크리스트.md`의 미체크(`[ ]`) 항목을 우선순위대로 구현**. 권장 시작점은 **Phase 7.3 main.ts God-file 분리** 또는 **Phase 7.5 잔여**(§6).

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

전체 상세(파일:라인 + 처방 + 노력 추정)는 **`체크리스트.md` Phase 7.5 / 7.3**에 정리돼 있다. 지금은 **God-file 분리 → 7.5 잔여(P2/P3)** 순으로 보면 된다.

> ⚠️ Phase 7의 🔴🟠🟡는 **그 감사 자체 기준**(Phase 0~6의 P0/P1/P2와 별개): 🔴 최우선(견고성) · 🟠 중간(성능/접근성/정리) · 🟡 폴리시.

### ▶ 권장 시작점: **Phase 7.3 main.ts God-file 분리** 또는 **Phase 7.5 잔여**

1. ~~**P1 노트 유실**~~ — `restore()` 후 `note-editor.ts`가 stale `board` 참조(부팅 시점 객체 고착). 새 노트가 live `board.items`에 안 들어가 저장/undo서 유실. 처방=createNoteEditor 호출의 `board,`→`get board(){return board}` + restore 시뮬 회귀테스트. **코드 반영 완료**.
2. ~~**P2 IME Enter ×2**~~ — `dialog.ts` 단일행 prompt와 `command-palette.ts` 검색창이 `isComposing` 미가드라 한글 조합 확정 Enter가 즉시 제출/명령실행된다. Enter 가드 추가. **코드 반영 완료**.
3. **P2 경미(여유 시)** — viewer 핀치 줌 중심 미보정·lightbox 단일이미지 화살표 순환·잠긴 단일 move 빈진입·autosave 다탭 TOCTOU.
4. **P3 굳히기(선택)** — supabase `orig` 가드·arrange-sort addedAt/z 혼합·toolbar innerHTML 폴백·export scale 상한.

### 그다음: **Phase 7.3 main.ts God-file 분리**
- `main.ts` 2266줄은 아직 크다. 현재는 `note-editor`·`cursor-reporter` 분리만 끝났고, 후보 잔여는 `pointer-input` / `drawing-tool` / `action-dispatcher` / `share-io` 쪽이다.
- 순서는 한 모듈씩, 기능 보존하면서 점진 분리.

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
- 최신 상태 기준 SSOT는 `체크리스트.md`다. 남은 건 7.3의 God-file 분리와 7.5 버그 감사 후속이다.

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

## 12. 🔴 전체 버그 감사 발견 (2026-06-28) — 12.1~12.3 코드 반영 완료, 12.4~12.5 잔여

> ⚠️ **이건 문서 작업이 아니라 코드(`app/src/*.ts`) 수정 작업이다.** 12.1~12.3는 현재 코드에 반영되었고, `cd app && npm run test && npm run build`도 통과했다. **문서만 바꾸고 끝내지 말 것.** 아래 패치는 적용 근거를 남겨 두는 용도다.
>
> 4차원 병렬 감사(데이터무결성·직렬화/공유 · `main.ts` 에디터 상호작용 · viewer/라이트박스/가상화 · UI·유틸/타입안전)에서 **검수자가 직접 코드 대조로 확정한 항목**. 12.1(P1)·12.2·12.3(P2)은 반영 완료, 12.4·12.5는 여유 시.
> 검증: 매 항목 후 `cd app && npm run test` / `cd app && npm run build` 0 에러. 커밋 아이덴티티 `fkrn75@gmail.com`(§9).

### 12.1 [x] 🔴 P1 — `restore()` 후 노트가 죽은(stale) `board`를 가리켜 **노트 유실**
- **파일**: `app/src/core/note-editor.ts`(66·73·102·105·112-113) + `app/src/main.ts`(649·1304-1319)
- **근본원인**: `main.ts:1307`에서 `createNoteEditor({ ..., board, ... })`로 `board`를 **부팅 시점 객체 참조**(shorthand = 그 순간의 값)로 넘긴다. 그런데 `restore()`(`main.ts:647-656`)는 `board = state`로 **새 객체를 재할당**한다 — 주석대로 "열기·undo·redo 공용"(+크래시복구·세션복구)이라 일상적으로 실행된다. 이후 `note-editor.ts`는 `deps.board.items`(66 find / 105 push / 112 filter)로 **옛 배열**을 읽고 쓴다. 결과: restore가 한 번이라도 일어난 뒤 노트를 새로 만들면 `deps.board.items.push()`가 옛 배열에 들어가 화면(scene)엔 보이지만 **live `board`엔 없어 autosave/undo 스냅샷에서 누락 → 노트 유실**. 기존 노트 편집도 옛 배열에서 검색해 무효화될 수 있다.
- **§11.1과의 관계**: 8be9dca(§11.1)는 `getNode` 캐스팅을 `board.items.find`로 고쳤지만 **`deps.board` 참조 자체가 stale인 건 못 고쳤다**. 그 `find`도 옛 배열에서 찾으므로 restore 후엔 여전히 깨진다. 같은 함수의 **잔존 회귀**(a30f425 God-file 분리가 도입). `note-editor.test.ts`가 restore를 안 해서(테스트의 `deps.board` === live board) 22/22 녹색이어도 살아있었다.
- **처방(권장, 최소 변경)**: `main.ts:1304-1319`의 호출에서 `board,` 한 줄을 **getter로** 바꾼다 → `get board() { return board },`. 객체 리터럴 getter라 `deps.board` 접근마다 live `board`를 돌려주므로 **`note-editor.ts`는 무수정**으로 해결된다(`NoteEditorDeps.board: BoardState` 타입도 그대로 유효).
- **회귀 테스트**: `note-editor.test.ts`에 "deps.board를 getter로 구성한 뒤 board 변수를 **새 BoardState로 교체**(=restore 시뮬) → 노트 생성/편집이 **새 board.items에 반영**되는지" 케이스 추가. 기존 두 테스트는 유지.
- **수용기준**: 파일 열기/undo/redo 후 ①새 노트 생성 → 저장·재로드 시 유지 ②기존 노트 편집 → 반영. 신규 테스트 포함 `npm run test`·`build` 0.
- **적용 패치(그대로 — `app/src/main.ts`의 createNoteEditor 호출, 현재 1307번째 줄)**. `note-editor.ts`는 손대지 않는다(getter라 `deps.board` 접근마다 live `board` 반환):
```diff
-  board,
+  get board() { return board },
```

### 12.2 [x] P2 — `dialog.ts` 단일행 prompt Enter가 **한글 IME 조합 중에도 즉시 제출**
- **파일**: `app/src/core/dialog.ts:55-61`
- **근본원인**: 단일행 input의 keydown이 `if (e.key === 'Enter') { e.preventDefault(); form.requestSubmit() }` — `e.isComposing` 미검사. 한글 조합 확정 Enter가 다이얼로그를 곧장 제출한다(보드 이름변경 등). `dialog-shell.ts:109`(§11.2)는 `!e.isComposing` 가드를 가지나 이 **필드 레벨** 핸들러엔 누락.
- **처방**: `if (e.key === 'Enter' && !e.isComposing)`로 가드 추가.
- **수용기준**: 한글 조합 중 Enter는 글자 확정만, 조합이 끝난 뒤 Enter로 제출.
- **적용 패치(그대로 — `app/src/core/dialog.ts`, 현재 57번째 줄)**:
```diff
-            if (e.key === 'Enter') {
+            if (e.key === 'Enter' && !e.isComposing) {
```

### 12.3 [x] P2 — `command-palette.ts` 검색창 Enter가 **IME 조합 중에도 명령 실행**
- **파일**: `app/src/core/command-palette.ts:307-311`
- **근본원인**: **캡처단계** handleKeydown의 `case 'Enter'`가 `e.isComposing` 검사 없이 `preventDefault()`+`runIndex(activeIndex)`. 한글 검색어 조합 확정 Enter가 글자 확정 대신 하이라이트된 명령을 실행한다(캡처단계라 input보다 먼저 가로챔).
- **처방**: Enter 분기 진입 시 조합 중이면 실행하지 말 것 — 예) `case 'Enter': if (e.isComposing) { e.stopPropagation(); break } e.preventDefault(); e.stopPropagation(); runIndex(activeIndex); break`. (캔버스 단축키 누수 방지용 `stopPropagation`은 유지, `preventDefault`+`runIndex`만 건너뜀.)
- **수용기준**: 한글 검색어 조합 Enter는 글자 확정, 그 다음 Enter로 명령 실행.
- **적용 패치(그대로 — `app/src/core/command-palette.ts`, 현재 307~311줄)**:
```diff
     case 'Enter':
+      if (e.isComposing) { e.stopPropagation(); break }
       e.preventDefault()
       e.stopPropagation()
       runIndex(activeIndex)
       break
```

### 12.4 [x] P2 (경미·엣지, 여유 시) — 상호작용 잔버그 묶음
> ⚠️ 재확인(2026-06-28 검수): **1번 핀치 줌은 오탐 — 정상이므로 건드리지 말 것.** 실제 처리 대상은 2(lightbox, 명확)·3(잠긴 move, 경미)·4(autosave, 선택).

- ~~`viewer/main.ts:145` 핀치 줌 중심 미보정~~ **✅ 정상(오탐) — 수정 금지.** `touch.ts`의 `toLocal`이 `clientX-rect.left`로 **host 로컬 px**를 cx/cy로 주고, 보정식 `cam.x = cx-(cx-cam.x)*applied`는 휠 줌의 `cam.x = mx-before.x*zoom`과 **수학적으로 동일**(mx도 host 로컬). 어긋남 없음.

- **[수정] `app/src/viewer/lightbox.ts:325`** 단일 이미지서 ←→ 키가 순환해 `show()` 재실행 → 확대/offset 리셋. nav 버튼은 1개면 이미 숨지만(`updateNavButtons`) 키보드 화살표가 `go()`를 그대로 호출. **패치**:
```diff
 function go(delta: number): void {
-  if (items.length === 0) return
+  if (items.length < 2) return
   const n = items.length
   show(((index + delta) % n + n) % n)
 }
```

- **[수정·경미] `app/src/main.ts:799-803`** 잠긴 아이템만 선택된 채 클릭 시 `origins`가 비어 빈 `move`로 진입(잡히는데 안 움직임). **패치**(origins 루프 직후·`others` 수집 전 삽입, return으로 빠지므로 아래 grabbing 커서 설정도 자연히 건너뜀):
```diff
    for (const id of sel.values()) {
      const img = getItem(id)
      if (img && !img.locked) origins.set(id, { x: img.transform.x, y: img.transform.y })
    }
    const rubber = maybeStartRubberDrag(origins.size, p.world, p.shift)
    if (rubber) {
      drag = rubber
      return
    }
    const others: AABB[] = []
```

- **[선택] `app/src/core/autosave.ts:124-141`** 다중탭 동시 saveNow read→write TOCTOU. **이미 `BroadcastChannel`(`lastObservedRemoteTs`)+`ts` 비교로 대부분 방어됨** — 잔여 미세 경합뿐. 난이도 대비 효용 낮음 → **현행 유지(스킵)**.

### 12.5 [ ] P3 (방어심도·엣지, 선택) — 굳히기
- `app/src/core/supabase-share.ts:176-178` 손상 가드가 `orig`는 검사 안 함(thumb/medium만) — 다운스트림 `assertNoDataUrls`가 막아 실손상 경로는 없으나 일관성용으로 `orig`도 조건 추가.
- `app/src/core/arrange-sort.ts:163` `av = a.addedAt ?? a.z` — addedAt(ms)과 z(작은 정수)를 같은 축에서 섞음. 한 보드에 둘이 혼재하면 "추가순" 왜곡. **처방**: addedAt 없으면 0이 아닌 폴백.
- `app/src/core/toolbar.ts:302` 라벨 폴백 `innerHTML`에 `def.title.charAt(0)` — 현재 하드코딩이라 무해하나 `opts.actions`로 외주입 시 XSS 표면. **처방**: 폴백을 `textContent`로.
- `app/src/core/export-image.ts:38-46` `scale` 상한 없음(하한 0.01만) — 비정상 큰 값이면 OOM 엣지. **처방**: `Math.min(8, …)` 등 상한.

### 작업 중 유지할 불변식 (재확인)
- `as unknown as`/`as any`로 board 모델(`BoardItem`)과 Pixi 렌더 노드(`ItemNode`)를 혼동하지 말 것 — 12.1은 캐스팅이 아니라 **참조 고착**이라는 변종이니, 같은 클래스(noteeditor가 live board를 못 봄)를 항상 의심.
- 매직바이트 방어선(`refb.ts`)·`deserialize` 하위호환 유지(§4·§10·§11).
- 검증: `cd app && npm run test` / `cd app && npm run build` 통과.

---

— 끝. 막히면 `체크리스트.md` Phase 7과 위 §4 불변식을 다시 확인할 것.
