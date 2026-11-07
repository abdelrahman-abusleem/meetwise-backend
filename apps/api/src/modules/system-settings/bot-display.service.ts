import {
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
} from '@meetwise/infrastructure/database';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import type { AuthenticatedUser } from '../auth/auth.types';

const publicDisplay = {
  id: true,
  defaultBotName: true,
  botDisplayVersion: true,
} as const;
type DisplayRow = {
  id: string;
  defaultBotName: string;
  botDisplayVersion: number;
};
const response = (row: DisplayRow) => ({
  id: row.id,
  displayName: row.defaultBotName,
  version: row.botDisplayVersion,
});

@Injectable()
export class BotDisplayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}
  async read() {
    const row = await this.prisma.systemSetting.findFirst({
      where: { singletonKey: 'system', setupCompleted: true },
      select: publicDisplay,
    });
    if (!row) throw new NotFoundException('Installation is not initialized');
    return response(row);
  }
  async update(actor: AuthenticatedUser, displayName: string, version: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.authority.assertActiveSystemActor(tx, actor, [
        SystemRole.OWNER,
        SystemRole.MANAGER,
      ]);
      const settings = await tx.systemSetting.findFirst({
        where: { singletonKey: 'system', setupCompleted: true },
        select: { id: true },
      });
      if (!settings)
        throw new NotFoundException('Installation is not initialized');
      const changed = await tx.systemSetting.updateMany({
        where: { id: settings.id, botDisplayVersion: version },
        data: {
          defaultBotName: displayName,
          botDisplayVersion: { increment: 1 },
        },
      });

      await this.assertFamilyUnexpired(tx, actor);
      if (changed.count !== 1)
        throw new PreconditionFailedException('Stale bot display version');
      await tx.botDisplayChange.create({
        data: {
          actorId: actor.id,
          settingsId: settings.id,
          version: version + 1,
        },
      });
      await this.assertFamilyUnexpired(tx, actor);
      return response(
        await tx.systemSetting.findUniqueOrThrow({
          where: { id: settings.id },
          select: publicDisplay,
        }),
      );
    });
  }
  private async assertFamilyUnexpired(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const family = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });

    if (!family || family.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
  }
}
