# 구글 연동 설정 (드라이브 백업 · 캘린더)

서버가 없는 앱이라 **본인 Google Cloud 프로젝트**의 OAuth 클라이언트를 씁니다. 한 번만 하면 됩니다.
PC와 폰이 같은 백업 파일을 보려면 **두 클라이언트가 같은 프로젝트**에 있어야 합니다(`drive.file` 권한은 같은 프로젝트가 만든 파일만 보입니다).

## 1. 프로젝트와 API

1. <https://console.cloud.google.com/> 에서 새 프로젝트를 만듭니다.
2. **API 및 서비스 › 라이브러리**에서 다음 두 개를 사용 설정합니다.
   - Google Drive API
   - Google Calendar API

## 2. OAuth 동의 화면

1. **API 및 서비스 › OAuth 동의 화면**(Google Auth Platform)에서 사용자 유형 **외부**를 고릅니다.
2. 앱 이름, 지원 이메일만 채우면 됩니다.
3. **범위(Scopes)**에 아래 세 개를 추가합니다.
   - `.../auth/drive.file` (이 앱이 만든 파일만 접근)
   - `.../auth/calendar.events`
   - `.../auth/userinfo.email`
4. 게시 상태를 **테스트**로 두고 **테스트 사용자**에 본인 구글 계정을 추가합니다.
   - 테스트 상태에서는 refresh token이 7일 뒤 만료되어 다시 로그인해야 합니다. 번거로우면 아래 **2-1**대로 프로덕션으로 게시하세요.

## 2-1. 프로덕션으로 게시 (소개·개인정보처리방침 페이지)

프로덕션으로 바꾸려면 **앱 이름, 지원 이메일, 홈페이지 URL, 개인정보처리방침 URL**이 있어야 합니다. 두 페이지는 `site/`에 있고 Firebase Hosting(무료 Spark 요금제)으로 올립니다.

1. **Firebase 프로젝트 연결**: [Firebase 콘솔](https://console.firebase.google.com/) › 프로젝트 추가 › **OAuth를 만든 그 Google Cloud 프로젝트**를 고릅니다. 주소는 `https://<프로젝트ID>.web.app`이 됩니다.
2. **문의 이메일**: 프로젝트 루트 `.env`에 `SITE_CONTACT_EMAIL=문의받을@주소`를 넣습니다. 페이지에 공개되는 주소이며, 저장소에는 올라가지 않습니다(배포할 때만 들어감). 비어 있으면 배포가 멈춥니다.
3. **배포**(처음 한 번은 로그인·프로젝트 선택):
   ```
   firebase login
   firebase use --add          # 위 프로젝트 선택 → .firebaserc 생성
   npm run site:deploy         # site/ → site-dist/ 빌드 후 Hosting에 업로드
   ```
4. **Google 인증 플랫폼 › 브랜딩**에 입력합니다. (지금 배포된 곳: `https://self-manager-k.web.app`, 방침은 `/privacy`)
   - 앱 홈페이지: `https://<프로젝트ID>.web.app`
   - 개인정보처리방침: `https://<프로젝트ID>.web.app/privacy`
   - 승인된 도메인: `<프로젝트ID>.web.app`
   - 서비스 약관은 비워 둬도 됩니다.
   - 앱 로고: 루트의 `icon.png`(120×120). **로고를 올리면 구글의 브랜드 인증을 받아야 동의 화면에 표시**되므로, 심사 없이 쓰려면 비워 두는 편이 빠릅니다.
5. **대상(Audience) › 앱 게시**. 캘린더 권한 때문에 "인증 필요"로 표시될 수 있지만, 인증 전에도 "확인되지 않은 앱" 경고(고급 → 이동)와 함께 사용자 100명까지 쓸 수 있습니다.
6. 게시 후 PC·폰에서 **다시 로그인**합니다(테스트 상태에서 받은 로그인은 7일 만료가 남을 수 있음).

## 3. PC(Windows)용 클라이언트

1. **사용자 인증 정보 › 사용자 인증 정보 만들기 › OAuth 클라이언트 ID**
2. 애플리케이션 유형: **데스크톱 앱**
3. 만들어진 값을 프로젝트 루트 `.env`에 넣고 다시 빌드합니다. 빌드할 때 앱에 들어가므로 설정 화면에서 입력할 필요가 없습니다.
   ```
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   ```
   - **"웹 애플리케이션" 유형은 안 됩니다.** PC 앱은 `http://127.0.0.1:임의포트`로 로그인 결과를 받는데, 이건 데스크톱 앱 유형만 허용됩니다(웹 유형은 `redirect_uri_mismatch`).
   - 데스크톱 앱 유형의 보안 비밀은 Google 문서상 "비밀로 취급되지 않는" 값이지만, `.env`는 `.gitignore`에 넣어 두었습니다.

## 4. Android용 클라이언트

1. 같은 화면에서 OAuth 클라이언트 ID를 하나 더 만듭니다. 유형: **Android**
2. 패키지 이름: `com.selfmanager.app`
3. SHA-1 인증서 지문: APK를 서명한 키의 SHA-1
   - 디버그 빌드: `keytool -list -v -keystore %USERPROFILE%\.android\debug.keystore -alias androiddebugkey -storepass android`
   - 릴리스 빌드: 본인 릴리스 키스토어의 SHA-1
4. 앱에서는 입력할 것이 없습니다. **설정 › 백업·동기화 › 구글 로그인**을 누르면 Google Play 서비스가 계정 선택·동의 화면을 띄웁니다.

### 릴리스 APK 서명 키

- **지금(v0.1.0)**: 릴리스 APK도 이 PC의 디버그 키(`%USERPROFILE%\.android\debug.keystore`)로 서명합니다. 위 3의 SHA-1이 그 키라 로그인이 되고, 개발용으로 설치한 앱 위에 덮어 설치됩니다.
- **주의**: 이 키는 이 PC에만 있습니다. 잃어버리면 기존 앱 위에 설치되는 업데이트를 더 만들 수 없으니 **`debug.keystore`를 따로 백업**해 두세요.
- **정식 릴리스 키로 바꾸기** (설정은 `scripts/android-setup.mjs` 6단계에 이미 있음):
  1. 키 만들기: `keytool -genkeypair -v -keystore selfmanager-release.jks -alias selfmanager -keyalg RSA -keysize 4096 -validity 10000`
  2. `src-tauri/gen/android/keystore.properties`(git 제외)에 적기:
     ```
     storeFile=../../../selfmanager-release.jks
     storePassword=...
     keyAlias=selfmanager
     keyPassword=...
     ```
     `storeFile`은 `src-tauri/gen/android` 기준 경로입니다(위 예시는 저장소 루트의 키 파일). 키 파일(`*.jks`)도 git에서 제외되어 있습니다.
  3. 새 키의 SHA-1로 **Android OAuth 클라이언트를 하나 더** 만듭니다(같은 프로젝트·같은 패키지 이름). 이전 클라이언트는 개발용으로 남겨 둬도 됩니다.
  4. 서명 키가 바뀌면 기존 앱 위에 덮어 설치되지 않으므로, 폰에서 앱을 지우고 새로 설치합니다(그 전에 드라이브에 백업).

## 동작 요약

| 기능 | PC | Android |
|---|---|---|
| 로그인 | 브라우저 + 로컬 루프백(127.0.0.1) PKCE | Google Identity AuthorizationClient |
| 백업 위치 | 내 드라이브 › `SelfManager/selfmanager-backup.db` | 같은 파일 |
| 자동 백업 | 창 X 버튼으로 닫을 때 | 앱이 백그라운드로 갈 때 |
| 자동 로드 | 켤 때 | 켤 때, 다시 돌아올 때 |
