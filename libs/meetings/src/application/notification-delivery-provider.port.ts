export interface SmtpEmailDeliveryCommand {
  readonly to: string;

  readonly kind: string;

  readonly bodySafe: string;

  readonly attempt: number;
}

export interface SmtpEmailDeliveryResult {
  readonly outcome:
    'CONFIRMED' | 'RETRYABLE_NO_EFFECT' | 'PERMANENT_DENIED' | 'UNKNOWN_EFFECT';

  readonly externalMessageId: string | null;
}

export interface NotificationSmtpProviderPort {
  sendEmail(
    command: SmtpEmailDeliveryCommand,
  ): Promise<SmtpEmailDeliveryResult>;
}
