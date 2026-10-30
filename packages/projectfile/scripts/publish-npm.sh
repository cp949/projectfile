#!/usr/bin/env bash
# npm 공개 레지스트리에 수동으로 배포한다.
# - 인증은 `npm login`으로 저장한 로그인 상태를 쓴다. 이 스크립트는 인증 정보를 다루지 않는다.
# - 배포 전에 HEAD를 가리키는 v<버전> 태그가 있는지 확인한다.
# - 나머지 인자는 `npm publish`에 넘긴다. 2FA 계정은 `--otp <코드>`를 붙인다.
# - 인자로 whoami를 주면 배포 없이 로그인 상태만 확인한다.
set -euo pipefail

REGISTRY="https://registry.npmjs.org/"

if [ "${1:-}" = "whoami" ]; then
  npm whoami --registry "$REGISTRY"
  exit 0
fi

version="$(node -p "require('./package.json').version")"
tag="v$version"
if ! tag_commit="$(git rev-parse --verify --quiet "$tag^{commit}")"; then
  echo "태그 $tag가 없다. 배포 전에 git tag $tag를 만든다." >&2
  exit 1
fi
if [ "$tag_commit" != "$(git rev-parse HEAD)" ]; then
  echo "태그 $tag가 HEAD를 가리키지 않는다." >&2
  exit 1
fi

# 스코프 패키지는 기본이 비공개라서 `--access public`을 고정한다.
npm publish --registry "$REGISTRY" --access public "$@"
