import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  timestamp: string;
  path: string;
  method: string;
  message: string | string[];
  error: string;
  requestId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Internal server error';
    let error = 'Internal Server Error';

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();

      if (statusCode < HttpStatus.INTERNAL_SERVER_ERROR) {
        const exceptionResponse = exception.getResponse();

        if (typeof exceptionResponse === 'string') {
          message = exceptionResponse;
          error = exception.name;
        } else {
          const payload = exceptionResponse as Record<string, unknown>;
          const payloadMessage = payload.message;

          if (
            typeof payloadMessage === 'string' ||
            (Array.isArray(payloadMessage) &&
              payloadMessage.every((item) => typeof item === 'string'))
          ) {
            message = payloadMessage;
          }

          error =
            typeof payload.error === 'string' ? payload.error : exception.name;
        }
      }
    }

    const requestId = request.requestId;
    const path = request.path;
    const stack = exception instanceof Error ? exception.stack : undefined;

    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId ?? 'unknown'}] ${request.method} ${path} - ${statusCode}`,
        stack,
      );
    }

    const body: ErrorResponseBody = {
      statusCode,
      timestamp: new Date().toISOString(),
      path,
      method: request.method,
      message,
      error,
      requestId,
    };

    response.status(statusCode).json(body);
  }
}
