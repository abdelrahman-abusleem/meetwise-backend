import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@meetwise/infrastructure/database';

describe('Prisma dependency compatibility (disposable PostgreSQL)', () => {
  let module: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
  });
  afterAll(async () => {
    await module?.close();
  });

  it('commits parameterized writes and reads in an ephemeral transaction', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`CREATE TEMP TABLE mw_dependency_probe (id integer PRIMARY KEY, value text) ON COMMIT DROP`;
      await tx.$executeRaw`INSERT INTO mw_dependency_probe VALUES (${1}, ${'synthetic'})`;
      return tx.$queryRaw<
        { id: number; value: string }[]
      >`SELECT id, value FROM mw_dependency_probe`;
    });
    expect(rows).toEqual([{ id: 1, value: 'synthetic' }]);
  });

  it('rolls back a constraint failure and keeps later transactions usable', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE mw_dependency_failure (id integer PRIMARY KEY) ON COMMIT DROP`;
        await tx.$executeRaw`INSERT INTO mw_dependency_failure VALUES (${1})`;
        await tx.$executeRaw`INSERT INTO mw_dependency_failure VALUES (${1})`;
      }),
    ).rejects.toThrow(/unique constraint|duplicate key/i);
    const rows = await prisma.$transaction(
      (tx) => tx.$queryRaw<{ ready: number }[]>`SELECT 1::int AS ready`,
    );
    expect(rows).toEqual([{ ready: 1 }]);
  });

  it('isolates concurrent transactions using shared immutable options', async () => {
    const options = Object.freeze({ timeout: 5000, maxWait: 5000 });
    const run = (value: number) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`CREATE TEMP TABLE mw_dependency_isolation (value integer) ON COMMIT DROP`;
        await tx.$executeRaw`INSERT INTO mw_dependency_isolation VALUES (${value})`;
        await tx.$queryRaw`SELECT 1::int AS ready FROM pg_sleep(0.05)`;
        return tx.$queryRaw<
          { value: number }[]
        >`SELECT value FROM mw_dependency_isolation`;
      }, options);
    expect(await Promise.all([run(11), run(22)])).toEqual([
      [{ value: 11 }],
      [{ value: 22 }],
    ]);
    expect(options).toEqual({ timeout: 5000, maxWait: 5000 });
  });
});
