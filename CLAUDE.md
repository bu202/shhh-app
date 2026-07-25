# CLAUDE.md — 수어 번역기 (텍스트 → 한국수어 KSL)

빌드 도구 없는 Vanilla PWA. 파파고풍 UI. **Phase 1 = 텍스트→수어** (Phase 2 = 카메라 수어→텍스트).

- **라이브**: https://bu202.github.io/sueo-translator/
- **레포**: https://github.com/bu202/sueo-translator (main 브랜치 = Pages 소스)

## 제약 (바뀌지 않는 전제)
- 예산 **$0**. 정적 호스팅(GitHub/Cloudflare Pages). 서버·백엔드 없음.
- Vanilla HTML/CSS/JS, **빌드 도구·프레임워크 없음**. 의존성 최소.
- 결정은 항상 **장단점 + 비용**을 표로 제시하고 승인받은 뒤 진행. 단계마다 실제 브라우저로 검증.

## 명령어
```bash
# 로컬 실행 (SW는 file://에서 안 돎)
python3 -m http.server 8000        # http://localhost:8000

# 데이터 수집 (키는 로컬 전용, 결과 JSON엔 키 미포함)
node scripts/fetch-ksl.mjs '<서비스키>'     # 전체 사전 수집(~3700+)
node scripts/fetch-ksl.mjs '<서비스키>' 200 # 상위 200개만
node scripts/fetch-ksl.mjs --mock           # 매핑 로직 자가검증(키·네트워크 불필요)
```

## 구조
| 경로 | 역할 |
|---|---|
| `index.html` | 진입점: 모드탭(수어→텍스트는 Phase2 자리) + 입력창 + 번역버튼 + 결과영역 + 크레딧 푸터 |
| `js/app.js` | 사전 인덱스·매칭·렌더·지화. 흐름: 입력→`matchSentence`(그리디)→`renderResults` |
| `data/ksl-dict.json` | 사전(내부 스키마). `scripts/fetch-ksl.mjs`가 생성 |
| `scripts/fetch-ksl.mjs` | 빌드타임 수집. `normalizeEntry`/`parseItems`가 API 교체 이음새 |
| `assets/fingerspelling/*.jpg` | 지화(한글 지문자) 32장 (CC BY-SA 3.0) |
| `service-worker.js` | network-first + 캐시 폴백 |
| `docs/API_KEY_GUIDE.md` | 서비스키 발급 절차 |

내부 스키마: `{ word, aliases:[], description, media:{ type:"images"|"video", src } }`

## 데이터 파이프라인
- API: **문화공공데이터광장(kcisa)** `https://api.kcisa.kr/openapi/service/rest/meta13/getCTE01701`
- **서비스키**는 culture.go.kr 활용신청 → `data@kcisa.kr` 이메일 발송. (data.go.kr "일반 인증키"와 다름 — 이건 안 씀)
- 응답 필드: `title`, `signDescription`, `signImages`(쉼표구분 이미지 URL), `alternativeTitle`, `referenceIdentifier`
- 매핑은 `normalizeEntry()` 한 곳에서. 필드/구조 바뀌면 여기만 수정.
- `toDict`는 **표제어+수형(이미지)** 기준 중복판정 → 이형태(변이) 보존. 재수집(키 필요) 후 변이 채워짐.
- **더 큰 사전 업그레이드 경로**(현 kcisa 일상생활수어 ~3,478보다 큼, 로그인 없이 파일 다운로드):
  - `data.go.kr/data/15135637` 한국수어사전_한국어대응표현정보(수형설명·대응표현·결합정보·대/소분류=이형태 포함)
  - `data.go.kr/data/15122687` 한국수어사전 표제어 및 용례
  - 채택 시 파일 컬럼에 맞춰 `normalizeEntry`만 교체(이음새). 문장 번역이 아닌 단어 커버리지 확대용.

---

## ⚠️ 함정과 실수 (다음 세션은 반복하지 말 것)

이번 개발에서 실제로 부딪힌 것들. 대부분 시간 잡아먹은 원인.

1. **keyword 검색이 사실상 안 됨.** kcisa getCTE01701은 비어있지 않은 `keyword`에 대해 데이터에 있는 단어("호랑이")조차 **0건** 반환. 부분검색 미지원 → 키워드 큐레이션 방식은 버리고 **전체 수집(numOfRows 크게)** 후 클라이언트에서 처리. `keyword=`는 비어도 URL에 **반드시 포함**해야 함(kcisa 주의사항).

2. **`title`이 동의어 쉼표 묶음.** 예 `"감사합니다,감사,고맙다"`. 그대로 word로 쓰면 "감사"가 매칭 안 됨. → 쉼표 split 후 **첫 단어=word, 나머지=aliases**. (`normalizeEntry`)

3. **이미지가 `http://` (sldict.korean.go.kr).** https 배포 시 **혼합콘텐츠로 차단**. → `httpsify()`로 https 승격. (sldict는 https 지원 확인됨)

4. **설명에 이중 인코딩 HTML 엔티티.** 예 `4&amp;#8231;5지` → `4‧5지`. `decodeEntities()`로 `&amp;` 먼저 푼 뒤 숫자 엔티티 디코드.

5. **인덱스 충돌(같은 별칭이 여러 표제어에).** "감사"가 `감사합니다`·`점검` 양쪽 별칭 → 순진하게 `Map.set`하면 뒤엣것이 이겨 오매칭. → `buildIndex`를 **표제어 우선 + 별칭 충돌은 먼저 온 것 우선** 2패스로.

6. **브라우저 HTTP 디스크 캐시.** JS를 고쳐도 `navigate`/새로고침으론 옛 파일이 뜸(SW 지워도). 개발 중엔 **하드리로드(Cmd+Shift+R)** 필요. 검증 시 `buildIndex.toString().includes(...)`로 새 코드 로드 여부부터 확인.

7. **Service Worker stale 캐시.** cache-first면 dict/JS 수정이 안 보임. → **network-first + 캐시 폴백**으로 통일(현재 방식). 배포 땐 이걸로 충분.

8. **zsh는 따옴표 없는 변수를 단어분리 안 함.** `for r in $list`가 한 덩어리로 돎. → **배열** `arr=(...)` + `"${arr[@]}"` 사용.

9. **Wikimedia는 반복 다운로드에 HTTP 429.** 지화 이미지 32장 루프 다운로드 시 rate-limit. → `--retry`/`--retry-delay`로 간격 두고 재시도. CDN 직링크(`upload.wikimedia.org`)도 IP 스로틀 걸리면 동일.

10. **지화 된소리 근사.** ㄲ=ㄱㄱ 등은 Wikimedia 세트에 전용 이미지가 없어 근사 표기 `[?]`. 현행 표준과 미세차이 가능.

11. **`hidden` 속성 vs `display:flex`.** `.io { display:flex }`가 HTML `hidden` 속성(`[hidden]{display:none}`)을 덮어써서 안 숨겨짐. → 전역 `[hidden]{display:none !important}` 추가로 해결. display 규칙 있는 요소를 hidden으로 토글하면 항상 주의.

12. **MediaPipe는 CDN 동적 import.** `import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs')` + WASM fileset + `hand_landmarker.task`(~7MB, googleapis). **오프라인/배포 시 로컬 vendoring 필요**(현재 CDN 의존, SW 미캐시). 카메라는 secure context(https/localhost) 필수. 모드 이탈 시 트랙 stop 필수(프라이버시).

---

## 라이선스
- 수어 데이터: 국립국어원 일상생활 수어 (이용허락범위 제한 없음, 무료).
- 지화 이미지: Wikimedia Commons "Korean manual alphabet" (Kwamikagami), **CC BY-SA 3.0** → 크레딧 표기 의무(푸터에 있음).

## 진행 상황
- ✅ Phase 1 (텍스트→수어): PWA 골격 / 사전 스키마 / UI / 그리디 문장매칭 / 지화 하이브리드
- ✅ 실 API 연동(3,622 표제어 · 변이 137단어 포함) / 실시간 변환(debounce+IME가드)
- ✅ 매칭 개선: (1) 활용 어미 흡수(`ENDINGS`, 미안"해"→년 오매칭 방지) (2) 동음이의 다중후보(`INDEX: Map<key,entry[]>`, "다른 뜻 N개" 파파고식 표시). `node scripts/test-match.mjs`로 검증.
  - ⚠️ 형태소 분석기 없음($0 vanilla) → 어미 흡수는 휴리스틱. KSL 문법 재배열 안 함 → 단어나열(수지한국어)이지 진짜 KSL 어순 아님. 문맥 기반 동음이의 선택 불가(후보 전부 노출).
- ✅ Phase 2 (C 스캐폴드): 카메라(getUserMedia) + MediaPipe Hand Landmarker 손뼈대 오버레이 + 모드전환.
- ✅ 지문자 인식(규칙기반): 자음 6종 ㄱ·ㄴ·ㅅ·ㅁ·ㅂ·ㅇ. 관절각 손가락 판정 + 시간 평활(6프레임). 실손 검증 완료.
  - 판정은 네 손가락(검지~새끼) 위주, 엄지는 ㄱ/ㄴ 구분에만(신뢰도 낮음). ㅇ=핀치+나머지3폄. 매핑은 assets/fingerspelling 대조로 교정.
  - ⚠️ 카메라는 정적 지문자만 가능. 단어 수어(안녕/사랑 등 고유 동작)는 궤적·양손·표정 필요 → 시간축 ML 영역, $0 정적 규칙 밖.
- ✅ 한글 음절 조합기: `assembleHangul(자모[])` → 완성형(초/중/종성 + 연음). `node scripts/test-assemble.mjs`로 검증(밥/안녕/사랑/한글/국어). 자모 확정 시 버퍼에 push→조합 표시, 스페이스/지우기 버튼.
- ✅ KNN 지문자 분류: 손 21점 정규화 벡터(손목원점+손크기스케일, 회전 보존)→최근접 다수결(k=3). localStorage 샘플, "자모 가르치기" UI로 사용자 학습. 샘플≥3이면 규칙 대신 KNN, 아니면 규칙 폴백. 방향 모음(ㅏ/ㅜ) 구분 검증 완료.
  - 튜닝값: `KNN_MAX=1.2`(거리임계), `SIGN_HOLD=6`. 미인식↑→임계 올림, 오인식↑→내림. 실손 튜닝 필요.
  - ⚠️ 여전히 정적 지문자만. 단어 수어(안녕/사랑 동작)는 시간축 ML 영역, $0 정적 규칙 밖.
- ✅ 배포: GitHub Pages (main 브랜치) → https://bu202.github.io/sueo-translator/ · 라이브 검증 완료(텍스트→수어, 카메라 손검출 both)
- ⬜ KNN 실손 튜닝 + 자모 샘플 수집(모음·나머지 자음)
- ⬜ MediaPipe 로컬 vendoring(오프라인 카메라용)
