import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  SystemRole,
  DepartmentKind,
} from '@meetwise/infrastructure/database';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ActorAuthorityService } from '../auth/services/actor-authority.service';
import { readConfig } from './wizard-config.dto';
import { draftExpiry } from './wizard-draft.policy';
import { completeWizardConfig } from './wizard-activation.policy';
type DepartmentView = {
  departmentId: string;
  kind: DepartmentKind;
  version: number;
};
function record(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceUnavailableException('Activation outcome unavailable');
  return value;
}
function outcome(value: Prisma.JsonValue) {
  const v = record(value);
  if (
    typeof v.activationId !== 'string' ||
    typeof v.completedAt !== 'string' ||
    typeof v.departmentChoice !== 'string' ||
    !['TECH', 'SALES', 'BOTH'].includes(v.departmentChoice) ||
    typeof v.botDisplayVersion !== 'number' ||
    !Array.isArray(v.departments)
  )
    throw new ServiceUnavailableException('Activation outcome unavailable');
  return {
    activationId: v.activationId,
    completedAt: v.completedAt,
    departmentChoice: v.departmentChoice,
    botDisplayVersion: v.botDisplayVersion,
    departments: v.departments.map((d) => {
      const x = record(d);
      if (
        typeof x.departmentId !== 'string' ||
        typeof x.kind !== 'string' ||
        !['TECH', 'SALES'].includes(x.kind) ||
        typeof x.version !== 'number'
      )
        throw new ServiceUnavailableException('Activation outcome unavailable');
      return { departmentId: x.departmentId, kind: x.kind, version: x.version };
    }),
    providerStatus: 'DISCONNECTED' as const,
    captureEnabled: false,
  };
}
@Injectable()
export class WizardActivationService {
  constructor(
    private readonly db: PrismaService,
    private readonly authority: ActorAuthorityService,
  ) {}
  async state(actor: AuthenticatedUser) {
    return this.db.$transaction(
      async (tx) => {
        await this.authority.assertActiveSystemActor(tx, actor, [
          SystemRole.OWNER,
          SystemRole.MANAGER,
        ]);
        const s = await tx.systemSetting.findUnique({
          where: { singletonKey: 'system' },
          select: {
            setupCompleted: true,
            wizardCompletedAt: true,
            wizardChoice: true,
            companyName: true,
            timezone: true,
            defaultLanguage: true,
            defaultBotName: true,
          },
        });
        if (!s?.setupCompleted) throw new NotFoundException();
        return {
          initialized: true,
          completed: s.wizardCompletedAt !== null,
          completedAt: s.wizardCompletedAt?.toISOString() ?? null,
          departmentChoice: s.wizardChoice,
          companyName: s.companyName,
          timezone: s.timezone,
          defaultLanguage: s.defaultLanguage,
          defaultBotName: s.defaultBotName,
          requiredFields: [
            'companyName',
            'timezone',
            'defaultLanguage',
            'defaultBotName',
            'departmentChoice',
            'departmentPlans',
          ],
          providerStatus: 'DISCONNECTED',
          captureEnabled: false,
        };
      },
      { timeout: 10000 },
    );
  }
  async activate(
    actor: AuthenticatedUser,
    id: string,
    match: unknown,
    key: unknown,
  ) {
    const version = this.version(match),
      requestHash = this.hashKey(key),
      requestDigest = createHash('sha256')
        .update(id + ':' + version)
        .digest('hex');

    const pre = await this.db.setupDraft.findFirst({
      where: { id, actorId: actor.id },
      select: { data: true },
    });
    if (!pre) throw new NotFoundException();
    const planned = readConfig(pre.data),
      operatorIds = [
        ...new Set(
          planned.departmentPlans?.flatMap((p) => p.operatorUserIds) ?? [],
        ),
      ];
    return this.db.$transaction(
      async (tx) => {
        await this.authority.assertActiveSystemActor(
          tx,
          actor,
          [SystemRole.OWNER, SystemRole.MANAGER],
          operatorIds,
        );
        const replay = await tx.wizardActivation.findUnique({
          where: { actorId_requestHash: { actorId: actor.id, requestHash } },
        });
        if (replay) {
          if (replay.requestDigest !== requestDigest)
            throw new ConflictException('Activation request key reused');
          return outcome(replay.result);
        }
        await tx.$queryRaw`SELECT id FROM setup_drafts WHERE id=${id}::uuid AND actor_id=${actor.id}::uuid FOR UPDATE`;
        const draft = await tx.setupDraft.findFirst({
          where: { id, actorId: actor.id },
        });
        if (!draft) throw new NotFoundException();
        this.assertDraftLive(draft);
        if (draft.version !== version)
          throw new PreconditionFailedException('Draft version changed');
        const config = completeWizardConfig(readConfig(draft.data));
        if (
          config.departmentPlans.some((p) =>
            p.operatorUserIds.some((x) => !operatorIds.includes(x)),
          )
        )
          throw new ConflictException('Draft operator plan changed');
        await this.validateOperators(
          tx,
          config.departmentPlans.flatMap((p) => p.operatorUserIds),
        );
        await tx.$queryRaw`SELECT id FROM system_settings WHERE singleton_key='system' FOR UPDATE`;
        const settings = await tx.systemSetting.findUnique({
          where: { singletonKey: 'system' },
        });
        if (!settings?.setupCompleted) throw new NotFoundException();
        if (settings.wizardCompletedAt)
          throw new ConflictException('First-run wizard already completed');
        const baseline = {
          companyName: settings.companyName,
          timezone: settings.timezone,
          defaultLanguage: settings.defaultLanguage,
          defaultBotName: settings.defaultBotName,
          botDisplayVersion: settings.botDisplayVersion,
        };
        if (!isDeepStrictEqual(draft.baseSettings, baseline))
          throw new ConflictException(
            'Global configuration changed since draft creation',
          );
        if (settings.autoDeleteTranscripts || settings.allowAudioStorage)
          throw new ConflictException(
            'Existing data policy requires separate configuration',
          );
        const outside = await tx.department.count({
          where: { status: 'ACTIVE', kind: { notIn: config.kinds } },
        });
        if (outside)
          throw new ConflictException(
            'Active department is outside initial choice',
          );
        if (
          await tx.setupDraftEvent.findFirst({
            where: { actorId: actor.id, requestHash },
          })
        )
          throw new ConflictException('Wizard request key already processed');
        const departments: DepartmentView[] = [];
        for (const kind of config.kinds)
          departments.push(await this.enableDepartment(tx, actor.id, kind));
        await this.assertSessionLive(tx, actor);
        this.assertDraftLive(draft);
        if (version >= 2147483647 || settings.botDisplayVersion >= 2147483647)
          throw new ConflictException('Configuration version exhausted');
        const now = new Date(Date.now()),
          displayChanged = settings.defaultBotName !== config.defaultBotName,
          botDisplayVersion =
            settings.botDisplayVersion + (displayChanged ? 1 : 0);
        await tx.systemSetting.update({
          where: { id: settings.id },
          data: {
            companyName: config.companyName,
            timezone: config.timezone,
            defaultLanguage: config.defaultLanguage,
            defaultBotName: config.defaultBotName,
            botDisplayVersion,
            wizardCompletedAt: now,
            wizardChoice: config.departmentChoice,
          },
        });
        if (displayChanged)
          await tx.botDisplayChange.create({
            data: {
              settingsId: settings.id,
              actorId: actor.id,
              version: botDisplayVersion,
            },
          });
        await tx.setupDraft.update({
          where: { id },
          data: { completedAt: now, version: { increment: 1 } },
        });
        await tx.setupDraftEvent.create({
          data: {
            draftId: id,
            actorId: actor.id,
            version: version + 1,
            action: 'ACTIVATED',
            requestHash,
          },
        });
        const activationId = randomUUID(),
          result = {
            activationId,
            completedAt: now.toISOString(),
            departmentChoice: config.departmentChoice,
            botDisplayVersion,
            departments,
            providerStatus: 'DISCONNECTED',
            captureEnabled: false,
          };
        await tx.wizardActivation.create({
          data: {
            id: activationId,
            settingsId: settings.id,
            draftId: id,
            actorId: actor.id,
            requestHash,
            requestDigest,
            result,
          },
        });
        await tx.setupOutbox.create({
          data: {
            activationId,
            topic: 'SETUP_ACTIVATED',
            payload: { activationId, departmentKinds: config.kinds },
          },
        });
        await this.assertSessionLive(tx, actor);
        this.assertDraftLive(draft);
        return outcome(result);
      },
      { timeout: 10000 },
    );
  }
  private assertDraftLive(row: {
    createdAt: Date;
    lastActivityAt: Date;
    expiresAt: Date;
    completedAt: Date | null;
  }) {
    if (
      row.completedAt ||
      row.expiresAt.getTime() <= Date.now() ||
      draftExpiry(row.createdAt, row.lastActivityAt).getTime() <= Date.now()
    )
      throw new NotFoundException();
  }
  private async assertSessionLive(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
  ) {
    const s = await tx.authSession.findUnique({
      where: { id: actor.familyId },
      select: { expiresAt: true },
    });
    if (!s || s.expiresAt.getTime() <= Date.now())
      throw new UnauthorizedException('Invalid session');
  }
  private async validateOperators(tx: Prisma.TransactionClient, ids: string[]) {
    const distinct = [...new Set(ids)],
      users = await tx.user.findMany({
        where: {
          id: { in: distinct },
          isActive: true,
          mustChangePassword: false,
          role: { in: [SystemRole.OWNER, SystemRole.MANAGER] },
        },
        select: { id: true },
      });
    if (users.length !== distinct.length)
      throw new BadRequestException(
        'Each operator must be a current active system OWNER or MANAGER',
      );
  }
  private async enableDepartment(
    tx: Prisma.TransactionClient,
    actorId: string,
    kind: DepartmentKind,
  ): Promise<DepartmentView> {
    const inserted = await tx.$queryRaw<
      { id: string }[]
    >`INSERT INTO departments (id,kind,status,version) VALUES (${randomUUID()}::uuid,${kind}::"DepartmentKind",'DISABLED',0) ON CONFLICT (kind) DO NOTHING RETURNING id`;
    void inserted;
    const rows = await tx.$queryRaw<
      { id: string; version: number; status: string }[]
    >`SELECT id,version,status FROM departments WHERE kind=${kind}::"DepartmentKind" FOR UPDATE`;
    const row = rows[0];
    if (row.status === 'ACTIVE')
      return { departmentId: row.id, kind, version: row.version };
    if (row.version >= 2147483647)
      throw new ConflictException('Department version exhausted');
    await tx.department.update({
      where: { id: row.id },
      data: { status: 'ACTIVE', version: { increment: 1 } },
    });
    await tx.departmentActivationEvent.create({
      data: {
        actorId,
        departmentId: row.id,
        fromStatus: 'DISABLED',
        toStatus: 'ACTIVE',
        version: row.version + 1,
      },
    });
    return { departmentId: row.id, kind, version: row.version + 1 };
  }
  private hashKey(value: unknown) {
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
