# 포함된 외부 라이브러리

이 폴더의 파일은 인터넷 연결 상태(학교 방화벽, CDN 차단 등)와 상관없이 돌아가도록 사이트에 직접 포함했습니다.

| 파일 | 라이브러리 | 버전 | 라이선스 |
|---|---|---|---|
| `firebase-app-compat.js`, `firebase-database-compat.js` | Firebase JavaScript SDK (compat 빌드) — https://github.com/firebase/firebase-js-sdk | 13.1.0 | Apache License 2.0 |
| `qrcode.js` | QR Code Generator for JavaScript (Kazuhiko Arase) — https://github.com/kazuhikoarase/qrcode-generator | 2.0.4 | MIT |

파일 내용은 npm 배포본 그대로이며, Firebase 파일에서는 소스맵 주소 한 줄만 지웠습니다.
