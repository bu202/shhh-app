# 수어 번역기 (텍스트 → 한국수어 KSL)

빌드 도구 없는 Vanilla PWA. Phase 1 = 텍스트→수어.

## 로컬 실행

정적 서버가 필요합니다 (service worker는 `file://`에서 안 돎):

```bash
cd ~/Desktop/claude/shhh\!
python3 -m http.server 8000
# http://localhost:8000 접속
```

## 구조

| 경로 | 역할 |
|---|---|
| `index.html` | 앱 진입점 |
| `css/style.css` | 스타일 |
| `js/app.js` | UI 흐름 + `normalizeEntry()` (실제 API 교체 이음새) |
| `data/ksl-dict.json` | 수어 사전 (mock) |
| `manifest.webmanifest` | PWA 매니페스트 |
| `service-worker.js` | 오프라인 precache |

## 데이터

한국수어 데이터는 공공데이터포털 `문화체육관광부_일상생활 수어` API(무료) 사용.
응답은 동영상이 아니라 **수형 이미지(`signImages`) + 텍스트 설명(`signDescription`)** 제공.

**빌드타임 수집** (키는 로컬에서만, 정적 사이트엔 키 미포함):
```bash
node scripts/fetch-ksl.mjs '<Encoding 인증키>'   # → data/ksl-dict.json 갱신
node scripts/fetch-ksl.mjs --mock                # 매핑 로직 자가검증(키·네트워크 불필요)
```
키 발급 절차는 [`docs/API_KEY_GUIDE.md`](docs/API_KEY_GUIDE.md) 참고.
매핑 수정은 `scripts/fetch-ksl.mjs`의 `normalizeEntry()` 한 곳.

### 지화(한글 지문자)

사전에 없는 단어는 한글을 자모로 분해해 지화 이미지 시퀀스로 표현(하이브리드).
지화 이미지: [Wikimedia Commons — Korean manual alphabet](https://commons.wikimedia.org/wiki/Category:Korean_manual_alphabet)
(Kwamikagami), **CC BY-SA 3.0**. `assets/fingerspelling/*.jpg` 32장.
된소리(ㄲ=ㄱㄱ 등)는 근사 표기이며 현행 표준과 미세차이 가능.
