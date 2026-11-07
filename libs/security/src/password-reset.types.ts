export const PASSWORD_RESET_ISSUE_RESULT = {
  STALE: 0,
  CREATED: 1,
  SAME_REQUEST: 2,
} as const;

export type PasswordResetIssueResult =
  (typeof PASSWORD_RESET_ISSUE_RESULT)[keyof typeof PASSWORD_RESET_ISSUE_RESULT];
