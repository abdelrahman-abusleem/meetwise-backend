import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

import { EnvironmentVariables } from '@meetwise/infrastructure/config';

export interface SendMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(configService: ConfigService<EnvironmentVariables, true>) {
    const host = configService.getOrThrow('SMTP_HOST', {
      infer: true,
    });

    const port = configService.getOrThrow('SMTP_PORT', {
      infer: true,
    });

    const secure =
      configService.getOrThrow('SMTP_SECURE', {
        infer: true,
      }) === 'true';

    const user = configService.get('SMTP_USER', {
      infer: true,
    });

    const password = configService.get('SMTP_PASSWORD', {
      infer: true,
    });

    this.from = configService.getOrThrow('SMTP_FROM', {
      infer: true,
    });

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      ...(user && password
        ? {
            auth: {
              user,
              pass: password,
            },
          }
        : {}),
    });
  }

  async send(options: SendMailOptions): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
    } catch {
      this.logger.error('Failed to send email');

      throw new ServiceUnavailableException(
        'Email service is temporarily unavailable',
      );
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      this.logger.warn('SMTP connection verification failed');

      return false;
    }
  }
}
