import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@meetwise/infrastructure/database';
import { INVALID_ACCESS_TOKEN } from '../../../common/constants/auth.constants';
import type { AuthenticatedRequest } from '../auth.types';
import { SessionFamilyService } from '../services/session-family.service';
import { AuthTokenService } from '../services/auth-token.service';
import { CookieService } from '../services/cookie.service';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly cookieService: CookieService,
    private readonly authTokenService: AuthTokenService,
    private readonly families: SessionFamilyService,
    private readonly prisma: PrismaService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const payload = await this.authTokenService.verifyAccessToken(
      this.cookieService.getAccessToken(request),
    );
    const identity = {
      familyId: payload.sid,
      userId: payload.sub,
      tokenVersion: payload.tokenVersion,
    };
    if (!(await this.families.isValid(identity)))
      throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    const user = await this.prisma.user.findFirst({
      where: {
        id: payload.sub,
        isActive: true,
        mustChangePassword: false,
        tokenVersion: payload.tokenVersion,
      },
      select: { id: true, email: true, role: true, tokenVersion: true },
    });
    if (!user) throw new UnauthorizedException(INVALID_ACCESS_TOKEN);
    request.user = { ...user, familyId: payload.sid };
    return true;
  }
}
