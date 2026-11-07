import type {
  SmtpEmailDeliveryCommand,
  SmtpEmailDeliveryResult,
} from '../../application/notification-delivery-provider.port';

export interface SmtpTransporterLike {
  sendMail(options: SmtpWireEnvelope): Promise<SmtpSentInfoLike>;
}

export interface SmtpWireEnvelope {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface SmtpSentInfoLike {
  readonly messageId?: string | undefined;
  readonly accepted?: readonly string[];
  readonly rejected?: readonly string[];
}

export interface NodemailerSendErrorLike {
  readonly code?: string;
  readonly command?: string;
}

export interface NodemailerSmtpDeliveryOptions {
  readonly transporter: SmtpTransporterLike;

  readonly fromAddress: string;
}

export function classifyNodemailerSendError(
  error: unknown,
): SmtpEmailDeliveryResult {
  const failure = error as Partial<NodemailerSendErrorLike> | null;
  const code = typeof failure?.code === 'string' ? failure.code : null;
  if (code === 'EAUTH' || code === 'ENOAUTH') {
    return { outcome: 'PERMANENT_DENIED', externalMessageId: null };
  }
  if (code === 'EENVELOPE') {
    return { outcome: 'RETRYABLE_NO_EFFECT', externalMessageId: null };
  }

  return { outcome: 'UNKNOWN_EFFECT', externalMessageId: null };
}

export class NodemailerSmtpDeliveryProvider {
  private readonly transporter: SmtpTransporterLike;
  private readonly fromAddress: string;

  constructor(options: NodemailerSmtpDeliveryOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      options.transporter === null ||
      typeof options.transporter !== 'object' ||
      typeof options.transporter.sendMail !== 'function'
    ) {
      throw new Error('smtp-provider-transport-facts-required');
    }
    if (
      typeof options.fromAddress !== 'string' ||
      options.fromAddress.trim() === ''
    ) {
      throw new Error('smtp-provider-sender-identity-required');
    }
    this.transporter = options.transporter;
    this.fromAddress = options.fromAddress;
  }

  async sendEmail(
    command: SmtpEmailDeliveryCommand,
  ): Promise<SmtpEmailDeliveryResult> {
    let info: SmtpSentInfoLike | undefined;
    try {
      info = await this.transporter.sendMail({
        from: this.fromAddress,
        to: command.to,
        subject: command.kind,
        text: command.bodySafe,
      });
    } catch (error) {
      return classifyNodemailerSendError(error);
    }
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    if (rejected.length > 0) {
      return { outcome: 'UNKNOWN_EFFECT', externalMessageId: null };
    }
    return { outcome: 'CONFIRMED', externalMessageId: null };
  }
}
