import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TranscriptKeyProvider } from './transcript-envelope';

export class TranscriptFileKeys implements TranscriptKeyProvider {
  constructor(private readonly path: () => string | undefined) {}
  activeVersion(): string {
    return this.read().activeVersion;
  }
  keyFor(version: string): Buffer | undefined {
    const keys = this.read().keys;
    const key = Object.hasOwn(keys, version) ? keys[version] : undefined;
    return key === undefined ? undefined : Buffer.from(key, 'base64');
  }
  private read(): { activeVersion: string; keys: Record<string, string> } {
    let descriptor: number | undefined;
    try {
      const path = this.path();
      if (!path || !isAbsolute(path) || path.startsWith('\\\\'))
        throw new Error();
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error();
      descriptor = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.size > 65_536 ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      )
        throw new Error();
      const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error();
      const ring = value as Record<string, unknown>;
      if (
        typeof ring.activeVersion !== 'string' ||
        !ring.activeVersion ||
        !ring.keys ||
        typeof ring.keys !== 'object' ||
        Array.isArray(ring.keys)
      )
        throw new Error();
      const keys = ring.keys as Record<string, unknown>;
      if (!Object.hasOwn(keys, ring.activeVersion)) throw new Error();
      for (const [version, key] of Object.entries(keys)) {
        if (!version || typeof key !== 'string') throw new Error();
        const decoded = Buffer.from(key, 'base64');
        if (decoded.length !== 32 || decoded.toString('base64') !== key)
          throw new Error();
      }
      return {
        activeVersion: ring.activeVersion,
        keys: keys as Record<string, string>,
      };
    } catch {
      throw new Error('Transcript encryption key unavailable');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
