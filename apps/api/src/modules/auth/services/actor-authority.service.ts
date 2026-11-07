import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { Prisma, SystemRole } from '@meetwise/infrastructure/database';
import type { AuthenticatedUser } from '../auth.types';

@Injectable()
export class ActorAuthorityService {
  async assertActiveSystemActor(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    allowedRoles: readonly SystemRole[],
    additionalUserId?: string | readonly string[],
  ): Promise<void> {
    const families = await tx.$queryRaw<
      { expiresAt: Date; revokedAt: Date | null; tokenVersion: number }[]
    >`
      SELECT expires_at AS "expiresAt", revoked_at AS "revokedAt", token_version AS "tokenVersion"
      FROM auth_sessions WHERE id = ${actor.familyId}::uuid AND user_id = ${actor.id}::uuid FOR UPDATE`;
    const family = families[0];
    if (
      !family ||
      family.revokedAt ||
      family.expiresAt.getTime() <= Date.now() ||
      family.tokenVersion !== actor.tokenVersion
    )
      throw new UnauthorizedException('Invalid session');
    const additionalIds =
      typeof additionalUserId === 'string'
        ? [additionalUserId]
        : (additionalUserId ?? []);
    const lockIds = [...new Set([actor.id, ...additionalIds])].sort();
    const users = await tx.$queryRaw<
      {
        id: string;
        role: SystemRole;
        isActive: boolean;
        mustChangePassword: boolean;
        tokenVersion: number;
      }[]
    >`
      SELECT id, role, is_active AS "isActive", must_change_password AS "mustChangePassword", token_version AS "tokenVersion"
      FROM users WHERE id IN (${Prisma.join(lockIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
    const user = users.find((user) => user.id === actor.id);
    if (
      !user?.isActive ||
      user.mustChangePassword ||
      user.tokenVersion !== actor.tokenVersion
    )
      throw new UnauthorizedException('Invalid session');

    if (family.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
    if (!allowedRoles.includes(user.role))
      throw new ForbiddenException('Insufficient system role');
  }
}
