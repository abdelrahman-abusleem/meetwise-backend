export interface SmokeTestJobData {
  message: string;
  sentAt: string;
}

export interface ResetAccountIdentity {
  userId: string;
  tokenVersion: number;
}

export interface SendPasswordResetEmailJobData extends ResetAccountIdentity {
  email: string;
  requestId: string;
  requestTimestamp: number;
}
