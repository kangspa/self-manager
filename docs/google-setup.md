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
   - 테스트 상태에서는 refresh token이 7일 뒤 만료되어 PC에서 다시 로그인해야 합니다. 번거로우면 **프로덕션으로 게시**하세요(본인만 쓰면 심사 없이 "확인되지 않은 앱" 경고만 뜹니다).

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

## 동작 요약

| 기능 | PC | Android |
|---|---|---|
| 로그인 | 브라우저 + 로컬 루프백(127.0.0.1) PKCE | Google Identity AuthorizationClient |
| 백업 위치 | 내 드라이브 › `SelfManager/selfmanager-backup.db` | 같은 파일 |
| 자동 백업 | 창 X 버튼으로 닫을 때 | 앱이 백그라운드로 갈 때 |
| 자동 로드 | 켤 때 | 켤 때, 다시 돌아올 때 |
