import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import nodemailer, { type Transporter } from 'nodemailer';
import { MailService, type SendMailOptions } from './mail.service';

const recipient = 'synthetic-recipient@example.invalid';
const options: SendMailOptions = {
  to: recipient,
  subject: 'Synthetic private subject',
  text: 'Synthetic reset link https://example.invalid/reset?token=SYNTHETIC',
  html: '<p>Synthetic private body</p>',
};

function rejectedValues(): [string, () => unknown][] {
  return [
    [
      'credential-bearing error',
      () => new Error('SYNTHETIC-SMTP-SECRET\r\n' + options.text),
    ],
    ['string', () => 'SYNTHETIC-SMTP-SECRET'],
    ['null', () => null],
    [
      'hostile Error.message',
      () =>
        Object.defineProperty(new Error(), 'message', {
          get() {
            throw new Error('Unsafe message inspection');
          },
        }),
    ],
    [
      'hostile coercion',
      () => ({
        [Symbol.toPrimitive]() {
          throw new Error('Unsafe coercion');
        },
      }),
    ],
    [
      'hostile prototype',
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('Unsafe instanceof');
            },
          },
        ),
    ],
  ];
}

async function capture(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

describe('MailService safe failure events', () => {
  let module: TestingModule;
  let service: MailService;
  let sendMail: jest.Mock<Promise<unknown>, [unknown]>;
  let verify: jest.Mock<Promise<unknown>, []>;
  let errors: unknown[][];
  let warnings: unknown[][];

  beforeEach(async () => {
    sendMail = jest
      .fn<Promise<unknown>, [unknown]>()
      .mockResolvedValue(undefined);
    verify = jest.fn<Promise<unknown>, []>().mockResolvedValue(true);
    errors = [];
    warnings = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    jest
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, verify } as unknown as Transporter);
    module = await Test.createTestingModule({
      providers: [
        MailService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            SMTP_HOST: 'smtp.example.invalid',
            SMTP_PORT: 587,
            SMTP_SECURE: 'false',
            SMTP_FROM: 'sender@example.invalid',
            SMTP_USER: 'SYNTHETIC-USER',
            SMTP_PASSWORD: 'SYNTHETIC-PASSWORD',
          }),
        },
      ],
    }).compile();
    service = module.get(MailService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
  });

  it('preserves transport configuration without making a network connection', () => {
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.invalid',
      port: 587,
      secure: false,
      auth: { user: 'SYNTHETIC-USER', pass: 'SYNTHETIC-PASSWORD' },
    });
  });

  it('forwards the unchanged mail payload and resolves without logging', async () => {
    await expect(service.send(options)).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: 'sender@example.invalid',
      ...options,
    });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('returns true when verification succeeds', async () => {
    await expect(service.verifyConnection()).resolves.toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it.each(rejectedValues())(
    'send failure: %s produces a fixed event and generic 503',
    async (_name, createError) => {
      sendMail.mockRejectedValueOnce(createError());
      const failure = await capture(() => service.send(options));
      expect(failure instanceof ServiceUnavailableException).toBe(true);
      if (!(failure instanceof ServiceUnavailableException))
        throw new Error('Expected generic service failure');
      expect(failure.getStatus()).toBe(503);
      expect(failure.message).toBe('Email service is temporarily unavailable');
      expect(errors).toEqual([['Failed to send email']]);
      expect(warnings).toEqual([]);
    },
  );

  it.each(rejectedValues())(
    'verify failure: %s produces a fixed warning and false',
    async (_name, createError) => {
      verify.mockRejectedValueOnce(createError());
      await expect(service.verifyConnection()).resolves.toBe(false);
      expect(warnings).toEqual([['SMTP connection verification failed']]);
      expect(errors).toEqual([]);
    },
  );

  it('does not read the recipient a second time while logging a failed send', async () => {
    let reads = 0;
    const input: SendMailOptions = {
      ...options,
      get to() {
        reads += 1;
        if (reads > 1) throw new Error('Unsafe catch-time recipient access');
        return recipient;
      },
    };
    sendMail.mockRejectedValueOnce(new Error('Synthetic failure'));
    const failure = await capture(() => service.send(input));
    expect(failure instanceof ServiceUnavailableException).toBe(true);
    expect(reads).toBe(1);
    expect(errors).toEqual([['Failed to send email']]);
  });

  it('can verify successfully after a transport failure', async () => {
    verify.mockRejectedValueOnce(new Error('Synthetic failure'));
    await expect(service.verifyConnection()).resolves.toBe(false);
    await expect(service.verifyConnection()).resolves.toBe(true);
    expect(warnings).toEqual([['SMTP connection verification failed']]);
  });
});
