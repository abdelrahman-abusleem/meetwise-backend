import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { RefreshTokenHasherService } from './refresh-token-hasher.service';

describe('Refresh token digest domains', () => {
  const modules: TestingModule[] = [];
  const makeHasher = async (secret: string) => {
    const module = await Test.createTestingModule({
      providers: [
        RefreshTokenHasherService,
        {
          provide: ConfigService,
          useValue: new ConfigService({ JWT_REFRESH_SECRET: secret }),
        },
      ],
    }).compile();
    modules.push(module);
    return module.get(RefreshTokenHasherService);
  };
  afterEach(async () => {
    for (const module of modules.splice(0)) await module.close();
  });

  it('preserves the legacy digest protocol using a published HMAC test vector', async () => {
    const hasher = await makeHasher('Jefe');
    expect(hasher.hash('what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
  it('family digests are not interchangeable with legacy/signing-key digests', async () => {
    const hasher = await makeHasher(randomBytes(48).toString('hex'));
    const token = randomBytes(48).toString('hex');
    const legacy = hasher.hash(token);
    const family = hasher.hashForFamily(token);
    expect(family).toMatch(/^[a-f0-9]{64}$/);
    expect(family).not.toBe(legacy);
    expect(hasher.compareForFamily(token, family)).toBe(true);
    expect(hasher.compareForFamily(token, legacy)).toBe(false);
    expect(hasher.compare(token, family)).toBe(false);
    expect(hasher.compareForFamily('another-token', family)).toBe(false);
  });
  it('derivation is deterministic within a configuration and separated across configurations', async () => {
    const secret = randomBytes(48).toString('hex');
    const a = await makeHasher(secret);
    const b = await makeHasher(secret);
    const c = await makeHasher(randomBytes(48).toString('hex'));
    expect(a.hashForFamily('synthetic')).toBe(b.hashForFamily('synthetic'));
    expect(a.hashForFamily('synthetic')).not.toBe(c.hashForFamily('synthetic'));
  });
  it('malformed stored digests deny without a timingSafeEqual length exception', async () => {
    const hasher = await makeHasher(randomBytes(48).toString('hex'));
    for (const invalid of ['', '0', 'zz'.repeat(32), '00'.repeat(33)]) {
      expect(hasher.compareForFamily('synthetic', invalid)).toBe(false);
    }
  });
});
