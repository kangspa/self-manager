# Self Manager

개인 관리 앱. 메모, 체크리스트, 가계부(알림 자동 기록), 개인 목표, 일기, 일일 관리, 일정, 업무(회의 녹음·받아쓰기·요약)를 한 곳에서 다룹니다.

- **서버 없음, 로그인 없음.** 모든 데이터는 기기 안 SQLite 파일 하나에 있습니다.
- **Windows exe + Android APK**를 같은 코드로 만듭니다 (Tauri 2: Rust 백엔드 + React UI).
- 구글 로그인은 **드라이브 백업과 PC·폰 간 이동, 구글 캘린더 연동**에만 씁니다.

## 구조

```
src/                React UI (페이지별 코드 분할)
  lib/api.ts        Rust 명령 호출 + 테이블 단위 변경 알림
  lib/hooks.ts      useRows / useAutosave 등
  pages/            화면
src-tauri/src/
  schema.rs         테이블 정의, 마이그레이션, 컬럼 화이트리스트
  db.rs             SQLite 연결, 범용 CRUD, 스냅샷/교체
  queries.rs        대시보드·일일 관리·정기 결제 집계
  sync.rs           수동 저장/로드, 드라이브 백업/로드, 자동 백업·로드
  google.rs         OAuth(PC 루프백 PKCE), Drive, Calendar REST
  calendar.rs       구글 캘린더 양방향 동기화, PC 알림
  notif.rs          알림 문구 → 지출 파싱
  stt.rs            녹음 수신, 오디오 가져오기, whisper.cpp 받아쓰기
  llm.rs            회의 요약 (llama.cpp, 기기 안에서 실행)
  models.rs         AI 모델 목록·이어받기·삭제·가져오기
  merge.rs          두 DB의 3-way 병합 (git 방식)
src-tauri/crates/whisper-lite/  whisper.cpp v1.9.5를 llama.cpp의 ggml 위에 빌드하는 작은 크레이트
  mobile.rs         Android 네이티브 플러그인 연결
src-tauri/android-src/  Kotlin: 알림 리스너, 구글 인증, 앱 목록
```

### 데이터 설계 (가벼움 우선)

- 노션처럼 행마다 페이지를 만들지 않습니다. 모든 기록은 고정 스키마 테이블의 **행 하나**이고, 필요한 인덱스만 둡니다.
- WAL 모드 + 준비된 문장 캐시. 목록은 기간·검색 조건으로 잘라서 읽습니다.
- 집계(대시보드, 일일 관리, 정기 결제 일정)는 Rust에서 SQL로 계산해 결과만 넘깁니다.
- UI의 모든 읽기/쓰기는 `db_list / db_upsert / db_delete` 범용 명령을 거치며, 테이블·컬럼 이름은 `schema.rs` 화이트리스트에 있는 것만 SQL에 들어갑니다.

### 저장 방식

| 이름 | 파일 | 언제 |
|---|---|---|
| 자동 저장 | `live.db` | 모든 변경 즉시 (화면 = 이 파일) |
| 수동 저장 | `manual.db` | 설정의 "이 기기에 수동 저장" 버튼 |
| 드라이브 백업 | `SelfManager/selfmanager-backup.db` | 버튼, 또는 자동 백업 |
| 병합 기준 | `base.db` | 이 기기와 드라이브가 마지막으로 같았던 상태 (자동) |

불러오기 버튼은 수동 저장본 또는 드라이브 백업 중 골라서 `live.db`를 덮어씁니다. 덮어쓰기 직전 파일은 `live.db.before-load`로 남습니다.
토큰·동기화 기록은 `device.json`에 따로 있어 백업에 섞이지 않습니다.

### 동기화 (git 방식)

모든 DB는 쓸 때마다 `meta.last_modified`를 찍고, 드라이브 파일에도 그 값이 같이 올라갑니다. 마지막 동기화 때의 값과 비교해서:

| 이 기기 | 드라이브 | 동작 |
|---|---|---|
| 그대로 | 바뀜 | 드라이브 내용 받기 |
| 바뀜 | 그대로 | 드라이브에 올리기 |
| 바뀜 | 바뀜 | `base.db` 기준 3-way 병합 후 올리기 |

병합은 행(id) 단위, 다시 칸(column) 단위로 합칩니다. 같은 칸을 양쪽이 다르게 고쳤거나, 한쪽은 지우고 다른 쪽은 고친 경우만 충돌이고,
그때만 **로컬 DB 우선 / 구글 드라이브 우선**을 고르는 창이 뜹니다(각각의 최근 저장 시각 표시). 창 닫기·백그라운드 전환 중에는 묻지 않고 다음 실행 때 묻습니다.
행 id는 `밀리초 × 1000 + 난수`라 기기마다 따로 만든 행이 겹치지 않습니다.

### 첨부 파일 동기화

메모·할 일·지출·목표·일기·업무 기록·회의에 이미지·영상·PDF 등을 붙일 수 있고, 회의 녹음도 같은 방식으로 저장됩니다.

- 파일 내용은 DB 밖 `files/<sha256>`에 두고, DB에는 이름·크기·해시·동기화 설정만 둡니다. DB는 작게 유지되고 행 단위로 병합됩니다.
- 드라이브에는 `SelfManager/files/<sha256>`로 올립니다. 이름이 곧 내용이라 **양쪽에 없는 파일만** 올리거나 받고, 이미 있는 파일은 다시 전송하지 않습니다. 받은 파일은 해시로 검증합니다.
- 동기화 대상: 파일별 설정(항상 / 안 함)이 우선이고, 없으면 **설정 › 백업·동기화**의 기준 용량(기본 10MB, 모든 기기 공통) 이하만.
- 파일을 길게 누르거나 우클릭하면 이름·동기화 여부를 바꿀 수 있습니다. 동기화하지 않는 파일은 다른 기기에서 이름과 "동기화되지 않음"만 보입니다.
- 동기화를 끄거나 지운 파일은 드라이브에서도 정리합니다. 단, 이 기기 DB가 드라이브 DB와 같을 때만 정리해서, 오래된 기기가 다른 기기의 새 파일을 지우지 않습니다.
- DB 동기화가 끝나면 파일은 백그라운드에서 주고받아 화면을 막지 않습니다. 큰 파일과 DB 백업 모두 이어 올리기(resumable) 업로드라 크기 제한이 없습니다.

### 업무

- 프로젝트 안에 **세부 단계(분기) · 업무 일정 · 업무 기록**을 만들고, 어느 항목에든 **AI 노트**(회의 녹음·받아쓰기·요약)를 붙입니다. 프로젝트에는 전체 일정(시작~종료)과 단계·일정 막대가 있습니다.
- 모든 업무는 `work_logs` 한 테이블입니다(`kind` 종류, `parent_id` 상위 단계, `date`~`end_date` 기간). 화면만 프로젝트별 / 날짜별(일·주·월)로 나눠 보여 줍니다.
- 일기·일정·업무 날짜별 보기는 같은 일·주·월 전환을 씁니다(`src/components/Period.tsx`).

## 개발 환경

필요한 것 (Windows):

- Node.js, Rust (stable, MSVC), Visual Studio Build Tools (C++)
- 온디바이스 AI(llama.cpp·whisper.cpp) 빌드용: CMake(VS Build Tools에 포함), LLVM(`winget install LLVM.LLVM`, bindgen이 libclang 사용)
- Android: JDK 17, Android SDK(platform 36, build-tools), NDK, `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android`

```powershell
npm install
npm run app                            # PC에서 개발 실행 (1420이 사용 중이면 빈 포트를 찾아 엶)
npm run tauri dev                      # 위와 같지만 1420 고정
npm run build:pc                       # Windows 빌드 → release\SelfManager.exe(설치 없이 실행) + 설치 파일
npm run tauri build                    # 위와 같지만 결과가 src-tauri\target\release 아래에만 생김
npm run tauri build -- --no-default-features   # 온디바이스 AI(whisper·llama) 없이 빌드
```

Android (PowerShell):

```powershell
. .\scripts\android-env.ps1     # JDK·SDK·NDK·whisper 크로스 빌드 환경 (셸마다 1회)
npm run tauri android init      # 최초 1회 (src-tauri/gen/android 생성)
node scripts/android-setup.mjs  # Kotlin 소스·권한·의존성·libc++_shared 적용 (init 후 1회)
npm run tauri android build -- --apk --target aarch64
```

- Tauri는 마지막에 `.so`를 심볼릭 링크로 연결하므로 **Windows 개발자 모드**가 켜져 있어야 합니다(설정 › 시스템 › 개발자용).
  켜기 어렵다면 Rust 빌드가 끝난 뒤 직접 복사하고 Gradle만 돌리면 됩니다:
  ```powershell
  Copy-Item src-tauri\target\aarch64-linux-android\debug\libself_manager_lib.so src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\
  cd src-tauri\gen\android; .\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug
  ```
- 릴리스 APK는 서명 키가 필요합니다. 구글 로그인용 Android OAuth 클라이언트에 그 키의 SHA-1을 등록하세요.

테스트:

```powershell
cd src-tauri; cargo test --no-default-features --lib
npm run typecheck
```

## 설정해야 하는 것

- **구글 연동**: [docs/google-setup.md](docs/google-setup.md). 프로젝트 루트 `.env`의 `GOOGLE_CLIENT_ID`(+`GOOGLE_CLIENT_SECRET`)가 빌드 때 앱에 들어갑니다. **데스크톱 앱** 유형이어야 합니다.
- **AI 모델**: 설정 › AI 모델에서 받기·선택·삭제. 받아쓰기(whisper)와 요약(GGUF) 모두 기기 안에서 실행되고 외부로 아무것도 보내지 않습니다.
  - 받아쓰기: PC `large-v3-turbo`, 폰 `small` 권장
  - 요약: PC Gemma 4 E2B/E4B, 폰 Qwen3.5 2B 권장. 다른 GGUF도 주소나 파일로 추가 가능
- **알림 가계부(Android)**: 설정 › 알림 가계부에서 앱을 고르고, 알림 접근 권한 허용

설치한 exe는 화면을 띄울 때 포트를 쓰지 않고(Tauri 내부 프로토콜), 구글 로그인 때만 OS가 고른 빈 포트를 잠깐 엽니다.

## 알려진 제한

- 화자 분리는 지원하지 않습니다.
- Android에서 녹음 중에는 화면이 켜져 있도록 잠금을 겁니다. 화면을 끄면 녹음이 멈출 수 있습니다.
- PC 일정 알림은 앱이 켜져 있을 때만 뜹니다(Android는 OS 예약 알림).
- 구글 캘린더 동기화는 기본 캘린더만, 3개월 전 ~ 12개월 후 범위를 맞춥니다. 반복 일정은 개별 일정으로 가져옵니다.
