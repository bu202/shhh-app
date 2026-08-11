# 수어 API 서비스키 발급 & 데이터 채우기 가이드

이 프로젝트는 **키를 로컬에서만** 사용해 데이터를 한 번 내려받아 `data/ksl-dict.json`으로
저장합니다(빌드타임 수집). 배포되는 정적 사이트에는 **키가 들어가지 않습니다**.

우리 엔드포인트는 `https://api.kcisa.kr/openapi/service/rest/meta13/getCTE01701` 이므로,
**문화공공데이터광장(culture.go.kr)** 에서 발급받은 **서비스키**를 사용합니다.
(data.go.kr 의 "일반 인증키"는 필요 없음 — 그건 data.go.kr 중계용)

---

## 1. 활용신청 (문화공공데이터광장)

1. [일상생활 수어 API 페이지](https://www.culture.go.kr/data/openapi/openapiView.do?id=367) 접속
2. **[활용신청]** 클릭 → Step1 신청자정보 → Step2 활용정보(개발목적/시스템유형) → Step3 완료
3. 완료 화면: **"서비스키는 신청하신 이메일로 발송됩니다."**

## 2. 서비스키 확인 (이메일)

- 발신 `data@kcisa.kr`, 제목 **"API 활용신청 안내"** 메일 확인
- 본문의 **서비스키** 문자열을 복사

## 3. 데이터 채우기 (스크립트 1회 실행)

프로젝트 폴더에서 (Node 18+; 이 환경은 Node 24):

```bash
cd /Users/bu/Desktop/claude/shhh!
node scripts/fetch-ksl.mjs '<이메일로_받은_서비스키>'
```

- 성공: `data/ksl-dict.json 생성: NN개 표제어 (수신 MM건)`
- 개수 조절: `node scripts/fetch-ksl.mjs '<키>' 50`
- 키는 **작은따옴표로 감싸기** (특수문자 대비)
- 스크립트는 응답이 JSON이든 XML이든 자동 판별해 처리

실행 후 로컬 서버에서 확인:
```bash
python3 -m http.server 8000   # http://localhost:8000
```

---

## 문제 해결

| 증상 | 원인 / 조치 |
|---|---|
| `항목 0개` + `scripts/last-response.txt` 생성 | 키 미반영(발급 직후 최대 1시간)·오류응답. 그 파일의 `resultMsg`/`returnAuthMsg` 확인 |
| `SERVICE_KEY_IS_NOT_REGISTERED` 류 | 키 반영 대기 후 재시도, 또는 키 문자열 오타/공백 |
| `파싱 실패` | 예상 못 한 응답 형식 → `scripts/last-response.txt` 구조 보고 `parseItems`/`extractJsonItems` 조정 |
| CORS 에러 | 이 방식은 브라우저가 아니라 **Node에서** 호출 → CORS 무관. 봤다면 클라이언트 직접호출한 것 |

## 참고: 응답 필드 → 내부 스키마 매핑 (`normalizeEntry`)

| API 필드 | 내부 필드 |
|---|---|
| `title` | `word` |
| `alternativeTitle` (쉼표구분) | `aliases[]` |
| `signDescription` (없으면 `description`) | `description` |
| `signImages` (쉼표구분, 없으면 `referenceIdentifier`) | `media.src[]` (type: images) |

수정이 필요하면 `scripts/fetch-ksl.mjs` 의 `normalizeEntry()` **한 함수만** 고치면 됩니다.

> ⚠️ 데이터 라이선스: 일상생활 수어(국립국어원, 이용허락범위 제한 없음).
> 지화 이미지와는 출처·라이선스가 다름(지화는 Wikimedia Commons CC BY-SA 3.0).
