# 배포

`@cp949/projectfile`은 npm 공개 레지스트리(`https://registry.npmjs.org/`)에 수동으로 배포한다. CI는 배포하지 않는다.

## 인증

- `npm login`으로 저장한 로그인 상태를 쓴다. `scripts/publish-npm.sh`는 인증 정보를 다루지 않는다.
- `@cp949` 스코프에 배포할 권한이 있는 계정이어야 한다.
- 인증 정보를 저장소 파일에 쓰지 않는다.
- 로그인 상태만 확인하려면 다음을 실행한다.

```sh
pnpm --filter @cp949/projectfile run publish:npm whoami
```

## changeset

공개 API나 동작을 바꾸는 작업은 changeset 파일을 함께 커밋한다.

```sh
pnpm changeset
```

| 종류    | 대상                           |
| ------- | ------------------------------ |
| `patch` | 버그 수정, 내부 변경           |
| `minor` | 새 기능                        |
| `major` | 기존 사용 코드와 어긋나는 변경 |

## 절차

1. 버전과 변경 로그를 만든다.
   ```sh
   pnpm changeset version
   ```
2. 커밋한다.
3. 클린 빌드와 검증을 실행한다.
   ```sh
   pnpm clean
   TURBO_FORCE=true pnpm verify
   pnpm check:consume
   pnpm check:package
   ```
   - `TURBO_FORCE=true`는 `verify` 안의 모든 turbo 실행이 캐시를 쓰지 않게 한다. `clean`은 `dist`만 지운다. 이 값이 없으면 `check-types`, `test`, `build`, `check:escompat`이 이전 결과를 캐시에서 복원하고 다시 실행하지 않는다.
   - `check:consume`과 `check:package`는 turbo를 거치지 않고 지금 `dist`를 묶는다. 바로 앞 `verify`의 `build`가 만든 `dist`를 쓴다.
   - `verify`는 `lint`, `format:check`, `check-types`, `test`, `build`, `check:escompat`, `check:license`를 차례로 실행한다.
   - `check:consume`은 `npm pack` tarball을 설치하므로 네트워크가 필요하다.
   - `check:package`는 `npm pack` tarball을 publint와 attw로 검사한다. 네트워크는 필요 없다.
   - 브라우저 시험(`test:browser`)은 `verify`에 들어가지 않아 이 단계에서 돌지 않는다.
   - CI의 `browser` 작업은 push 뒤에 돈다. 배포 커밋의 결과는 6단계 뒤에 나온다.
   - 배포 전에 확인하려면 로컬에서 `pnpm --filter @cp949/projectfile test:browser`를 실행한다. Chromium 설치가 필요하다. 설치 명령은 `docs/agents/extra-checks.md`의 "브라우저 시험"을 따른다.
4. 버전 태그를 만든다. `package.json`의 버전과 맞춘다.
   ```sh
   git tag v<버전>
   ```
5. 배포한다. 스크립트가 `v<버전>` 태그가 HEAD를 가리키는지 먼저 확인한다. 없으면 멈춘다.
   ```sh
   pnpm --filter @cp949/projectfile run publish:npm
   ```
   - 스크립트는 `--access public`을 붙인다. 스코프 패키지는 이 옵션이 없으면 비공개로 배포하려다 실패한다.
   - 2FA 계정은 OTP를 넘긴다. 나머지 인자는 `npm publish`로 간다.
   ```sh
   pnpm --filter @cp949/projectfile run publish:npm --otp <코드>
   ```
6. 커밋과 태그를 원격에 올린다.
   ```sh
   git push origin main --follow-tags
   ```

배포가 실패하면 로컬 태그를 지우고 원인을 고친 뒤 다시 만든다.

```sh
git tag -d v<버전>
```

`npm publish`는 `prepublishOnly`로 `build`를 먼저 돌린다. `dist`가 없어도 빈 패키지가 올라가지 않는다.

각 단계가 성공한 뒤에만 다음으로 간다.
