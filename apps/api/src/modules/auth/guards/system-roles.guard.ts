import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemRole } from '@meetwise/infrastructure/database';
import type { AuthenticatedRequest } from '../auth.types';
import { SYSTEM_ROLES_KEY } from '../decorators/system-roles.decorator';

@Injectable()
export class SystemRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new UnauthorizedException();
    const allowed = this.reflector.getAllAndOverride<readonly SystemRole[]>(
      SYSTEM_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!allowed?.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
