// README의 Worker 예제가 `./project-config`에서 가져오는 값이다.
// "사용"의 kind, rules, limits를 내보내는 사용처 모듈을 대신한다.
import type {
  ProjectFileLimits,
  ProjectFileRules,
  ProjectKind,
} from "@cp949/projectfile";

export declare const kind: ProjectKind;
export declare const rules: ProjectFileRules;
export declare const limits: ProjectFileLimits;
