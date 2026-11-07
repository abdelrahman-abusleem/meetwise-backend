import { readOwnerRecoveryInput } from './recovery-input';
import { config as loadEnvironment } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { isEmail } from 'class-validator';
import { OwnerRecoveryModule } from './owner-recovery.module';
import { OwnerRecoveryService } from './owner-recovery.service';

async function main(): Promise<void> {
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  let output: string | undefined;
  try {
    const [command, email, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      !['issue', 'consume'].includes(command) ||
      (command === 'issue' &&
        (typeof email !== 'string' || email.length > 254 || !isEmail(email))) ||
      (command === 'consume' && email !== undefined)
    )
      throw new Error('Invalid command');
    const input =
      command === 'consume'
        ? await readOwnerRecoveryInput(process.stdin)
        : undefined;
    loadEnvironment({ quiet: true, debug: false });
    app = await NestFactory.createApplicationContext(OwnerRecoveryModule, {
      logger: false,
      abortOnError: false,
    });
    const service = app.get(OwnerRecoveryService);
    if (command === 'issue')
      output = await service.issue(email.trim().toLowerCase());
    else if (input) await service.consume(input.credential, input.newPassword);
  } catch {
    process.stderr.write(
      'OWNER recovery failed. Check command, credential, account and local database configuration.\n',
    );
    process.exitCode = 1;
  } finally {
    try {
      await app?.close();
    } catch {
      process.stderr.write('OWNER recovery cleanup failed.\n');
      process.exitCode = 1;
    }
  }
  if (!process.exitCode && output) process.stdout.write(output + '\n');
}
void main();
