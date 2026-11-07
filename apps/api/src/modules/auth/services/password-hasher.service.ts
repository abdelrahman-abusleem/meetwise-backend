import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.HashOptions & {
  raw?: false;
} = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
};

@Injectable()
export class PasswordHasherService {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    return argon2.verify(passwordHash, password);
  }

  needsRehash(passwordHash: string): boolean {
    return argon2.needsRehash(passwordHash, ARGON2_OPTIONS);
  }
}
