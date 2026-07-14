import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

@Injectable()
export class HttpLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HttpLoggingMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const incomingRequestId = request.header('x-request-id')?.trim();

    const requestId =
      incomingRequestId && /^[a-zA-Z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    const startedAt = process.hrtime.bigint();

    response.once('finish', () => {
      const finishedAt = process.hrtime.bigint();
      const durationMs = Number(finishedAt - startedAt) / 1_000_000;

      const message = [
        `[${requestId}]`,
        request.method,
        request.path,
        response.statusCode,
        `${durationMs.toFixed(2)}ms`,
      ].join(' ');

      if (response.statusCode >= 500) {
        this.logger.error(message);
      } else if (response.statusCode >= 400) {
        this.logger.warn(message);
      } else {
        this.logger.log(message);
      }
    });

    next();
  }
}
