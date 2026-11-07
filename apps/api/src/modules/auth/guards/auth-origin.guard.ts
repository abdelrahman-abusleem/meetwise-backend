import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class AuthOriginGuard implements CanActivate {
  private readonly origin: string;
  constructor(config: ConfigService) {
    const url = new URL(config.getOrThrow<string>('WEB_APP_URL'));
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('WEB_APP_URL must identify a trusted HTTP origin');
    this.origin = url.origin;
  }
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (request.headers.origin !== this.origin)
      throw new ForbiddenException('Untrusted request origin');
    return true;
  }
}
