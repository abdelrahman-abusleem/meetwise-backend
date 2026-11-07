import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SetupTokenService } from './setup-token.service';

@Injectable()
export class SetupBootstrapGuard implements CanActivate {
  constructor(private readonly tokens: SetupTokenService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    await this.tokens.check(request.headers['x-meetwise-setup-token']);
    return true;
  }
}
