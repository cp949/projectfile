# 분류 라벨

이슈 분류는 역할 이름으로 말한다. 이 문서는 역할을 GitHub 이슈의 실제 라벨 문자열에 대응시킨다. 라벨 문자열은 역할 이름과 같다.

## 상태 역할

| 역할              | 라벨              | 의미                                   |
| ----------------- | ----------------- | -------------------------------------- |
| `needs-triage`    | `needs-triage`    | 관리자가 평가해야 한다                 |
| `needs-info`      | `needs-info`      | 보고자의 추가 정보를 기다린다          |
| `ready-for-agent` | `ready-for-agent` | 명세가 끝나 에이전트가 단독으로 맡는다 |
| `ready-for-human` | `ready-for-human` | 사람이 구현해야 한다                   |
| `wontfix`         | `wontfix`         | 처리하지 않는다                        |

## 분류 역할

| 역할          | 라벨          | 의미                  |
| ------------- | ------------- | --------------------- |
| `bug`         | `bug`         | 동작이 깨졌다         |
| `enhancement` | `enhancement` | 새 기능 또는 개선이다 |

## 규칙

- 분류가 끝난 이슈는 상태 라벨 하나와 분류 라벨 하나를 가진다.
- 역할을 말하면 위 표의 라벨 문자열을 쓴다.
- `deferred`는 분류 역할이 아니다. 보류 규칙은 `docs/agents/issue-tracker.md`의 "상태 규칙"을 따른다.
- 라벨 변경은 `gh issue edit <번호> --add-label "..."` / `--remove-label "..."`로 한다.
- 저장소에 라벨이 없으면 `gh label create <라벨> --color RRGGBB`로 먼저 만든다.
