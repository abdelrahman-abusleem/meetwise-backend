import {
  BadRequestException,
  ConflictException,
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
import { createHash } from 'node:crypto';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import {
  WizardConfigDto,
  configSnapshot,
  readConfig,
} from './wizard-config.dto';
import { draftExpiry } from './wizard-draft.policy';
type Draft = Prisma.SetupDraftGetPayload<Record<string, never>>;
function view(row: Draft) {
  return {
    draftId: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    config: readConfig(row.data),
  };
}
@Injectable()
export class WizardDraftsService {
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}
  async create(
    actor: AuthenticatedUser,
    config: WizardConfigDto,
    key: unknown,
  ) {
    const requestHash = this.requestHash(key);
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, actor);
        await this.assertOpen(tx, actor);
        const settings = await tx.systemSetting.findUnique({
          where: { singletonKey: 'system' },
          select: {
            setupCompleted: true,
            companyName: true,
            timezone: true,
            defaultLanguage: true,
            defaultBotName: true,
            botDisplayVersion: true,
          },
        });
        if (!settings?.setupCompleted) throw new NotFoundException();
        await this.uniqueRequest(tx, actor.id, requestHash);
        const now = new Date(Date.now());
        const { setupCompleted, ...baseSettings } = settings;
        void setupCompleted;
        const row = await tx.setupDraft.create({
          data: {
            actorId: actor.id,
            data: configSnapshot(config),
            baseSettings,
            createdAt: now,
            lastActivityAt: now,
            expiresAt: draftExpiry(now, now),
          },
        });
        await tx.setupDraftEvent.create({
          data: {
            draftId: row.id,
            actorId: actor.id,
            version: 1,
            action: 'CREATED',
            requestHash,
          },
        });
        await this.assertActor(tx, actor);
        return view(row);
      },
      { timeout: 10000 },
    );
  }
  async get(actor: AuthenticatedUser, id: string) {
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, actor);
        const row = await this.lockDraft(tx, actor, id);
        await this.assertActor(tx, actor);
        return view(row);
      },
      { timeout: 10000 },
    );
  }
  async update(
    actor: AuthenticatedUser,
    id: string,
    config: WizardConfigDto,
    match: unknown,
    key: unknown,
  ) {
    const version = this.version(match),
      requestHash = this.requestHash(key);
    return this.db.$transaction(
      async (tx) => {
        await this.authorize(tx, actor);
        const current = await this.lockDraft(tx, actor, id);
        await this.assertOpen(tx, actor);
        this.assertDraftLive(current);
        await this.uniqueRequest(tx, actor.id, requestHash);
        if (current.version !== version)
          throw new PreconditionFailedException('Draft version changed');
        if (version >= 2147483647)
          throw new ConflictException('Draft version exhausted');
        const now = new Date(Date.now());
        const row = await tx.setupDraft.update({
          where: { id },
          data: {
            data: configSnapshot(config),
            version: { increment: 1 },
            lastActivityAt: now,
            expiresAt: draftExpiry(current.createdAt, now),
          },
        });
        await tx.setupDraftEvent.create({
          data: {
            draftId: id,
            actorId: actor.id,
            version: row.version,
            action: 'UPDATED',
            requestHash,
          },
        });
        await this.assertActor(tx, actor);
        return view(row);
      },
      { timeout: 10000 },
    );
  }
  private async authorize(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    await this.assertActor(tx, actor);
    if (
      !(await tx.systemSetting.findFirst({
        where: { singletonKey: 'system', setupCompleted: true },
        select: { id: true },
      }))
    )
      throw new NotFoundException();
  }
  private async assertActor(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    await this.authority.assertActiveSystemActor(tx, actor, [
      SystemRole.OWNER,
      SystemRole.MANAGER,
    ]);
  }
  private async lockDraft(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    id: string,
  ) {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM setup_drafts WHERE id=${id}::uuid AND actor_id=${actor.id}::uuid FOR UPDATE`;
    const session = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
    if (!rows.length) throw new NotFoundException();
    const row = await tx.setupDraft.findUniqueOrThrow({ where: { id } });
    this.assertDraftLive(row);
    return row;
  }

  private async assertOpen(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    await tx.$queryRaw`SELECT id FROM system_settings WHERE singleton_key='system' FOR UPDATE`;
    const session = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
    const settings = await tx.systemSetting.findUnique({
      where: { singletonKey: 'system' },
      select: { setupCompleted: true, wizardCompletedAt: true },
    });
    if (!settings?.setupCompleted) throw new NotFoundException();
    if (settings.wizardCompletedAt)
      throw new ConflictException('First-run wizard already completed');
  }
  private assertDraftLive(row: Draft) {
    if (
      row.completedAt ||
      row.expiresAt.getTime() <= Date.now() ||
      draftExpiry(row.createdAt, row.lastActivityAt).getTime() <= Date.now()
    )
      throw new NotFoundException();
  }
  private async uniqueRequest(
    tx: Prisma.TransactionClient,
    actorId: string,
    requestHash: string,
  ) {
    if (
      await tx.setupDraftEvent.findFirst({
        where: { actorId, requestHash },
        select: { id: true },
      })
    )
      throw new ConflictException('Draft request already processed');
  }
  private requestHash(value: unknown) {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(value))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return createHash('sha256').update(value).digest('hex');
  }
  private version(value: unknown) {
    if (typeof value !== 'string' || !/^"[1-9][0-9]{0,9}"$/.test(value))
      throw new BadRequestException('Quoted If-Match version is required');
    const n = Number(value.slice(1, -1));
    if (n > 2147483647) throw new BadRequestException('Invalid draft version');
    return n;
  }
}
