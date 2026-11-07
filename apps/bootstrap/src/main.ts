import { config as loadEnvironment } from 'dotenv';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { SetupTokenService } from '../../api/src/modules/setup/setup-token.service';

@Module({ imports: [DatabaseModule], providers: [SetupTokenService] })
class BootstrapCliModule {}

async function issueBootstrap(): Promise<void> {
  loadEnvironment({ quiet: true, debug: false });
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  let token: string;
  try {
    app = await NestFactory.createApplicationContext(BootstrapCliModule, {
      logger: false,
      abortOnError: false,
    });
    token = await app.get(SetupTokenService).issue();
  } catch {
    process.stderr.write(
      'Bootstrap token issuance failed. Check installation state and database configuration.\n',
    );
    process.exitCode = 1;
    return;
  } finally {
    try {
      await app?.close();
    } catch {
      process.stderr.write('Bootstrap resource cleanup failed.\n');
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) process.stdout.write(token + '\n');
}
void issueBootstrap();
