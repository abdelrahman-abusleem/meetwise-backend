export interface BotJoinDispatchPayload {
  readonly meetingId: string;
  readonly botSessionId: string;

  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly joinUrl: string;
}

export type BotJoinPortObservation =
  | 'JOINING'
  | 'WAITING_FOR_HOST'
  | 'ADMITTED'
  | 'DENIED'
  | 'TIMED_OUT'
  | 'PROVIDER_UNAVAILABLE';

export interface BotJoinProviderPort {
  attemptJoin(payload: BotJoinDispatchPayload): Promise<BotJoinPortObservation>;
}
