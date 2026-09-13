# GitHub Actions로 주간 발송하기

이 저장소의 워크플로는 매주 수요일 20:00(한국시간)에 다음 월요일부터 일요일까지의 21끼 식단을 만들고 텔레그램으로 보냅니다. GitHub-hosted runner에서 실행되므로 컴퓨터가 꺼져 있어도 됩니다. 식단은 `cloud-data/recipes.ndjson`에 보관한 은평구 공개 레시피 색인을 사용하며, 생성된 메뉴와 출처 기록은 `menus/weekly/`에 저장됩니다.

## 1. 저장소 만들기

GitHub에서 **Private repository**를 만들고 이 폴더를 연결합니다. 저장소 이름은 예를 들어 `baby-meal-telegram`으로 하면 됩니다. 초기 README·.gitignore·License는 만들지 않습니다.

이 폴더에서 처음 한 번만 실행합니다.

현재 작업 폴더에는 `origin`이 이미 사용자 저장소 주소로 등록되어 있습니다.

```powershell
cd "C:\Users\rhj27\OneDrive\Desktop\Codex file\아기식단_텔레그램"
git push -u origin main
```

`.state/telegram.dpapi`와 원본 HWP/XLSX 파일은 업로드하지 않습니다. `cloud-data/recipes.ndjson`는 공개 자료에서 만든 검색 색인입니다. 저장소 주소가 다르면 `origin` URL만 실제 주소로 바꿉니다.

## 2. Secrets 등록

저장소의 **Settings → Secrets and variables → Actions → New repository secret**에서 아래 두 개를 등록합니다.

- `TELEGRAM_BOT_TOKEN`: BotFather가 발급한 봇 토큰
- `TELEGRAM_CHAT_ID`: 연결한 개인 채팅방 ID

토큰은 이 대화에 보내지 말고 GitHub 입력창에만 붙여넣습니다. 채팅방 ID는 기존 연결 PC에서 봇 연결에 사용한 개인 채팅방의 숫자 ID를 확인해 입력합니다.

채팅방 ID만 확인할 때는 이 폴더에서 `node telegram.mjs chat-id`를 실행합니다. 숫자만 출력되며 봇 토큰은 출력하지 않습니다.

## 3. 첫 주 발송

**Actions → 아기 주간 식단 텔레그램 → Run workflow**에서 `week_start`에 `2026-09-14`를 입력하고 `send`를 켠 뒤 실행합니다. 기존에 검증한 첫 주 파일을 그대로 보내며, 이미 보낸 주는 `cloud-state/receipts.json`으로 중복을 막습니다.

## 4. 이후 자동 실행

수요일 20:00(한국시간)에 다음 주 식단을 생성하고 발송합니다. `schedule`은 UTC 기준으로 `0 11 * * 3`에 설정되어 있습니다. 수동으로 식단만 만들 때는 `send`를 끄면 됩니다.

GitHub Actions의 무료 실행 한도 안에서 주 1회 작업을 수행합니다. 이 구성은 OpenAI API를 호출하지 않으므로 별도 모델 API 키가 필요하지 않습니다. GitHub Actions 한도와 Telegram 네트워크 상태에 따라 실행 결과가 달라질 수 있습니다.
