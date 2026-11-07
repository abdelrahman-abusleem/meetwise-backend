import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExportObjectStorePort,
  ExportStoreCommand,
  ExportStorageOutcome,
} from '../../application/export-object-store.port';

export interface LocalExportObjectStoreOptions {
  readonly rootDirectory: string;
}

interface ArtifactManifestFacts {
  readonly exportId: string;
  readonly kind: string;
  readonly format: string;
  readonly byteLength: number;
}

export class LocalExportObjectStore implements ExportObjectStorePort {
  private readonly rootDirectory: string;

  constructor(options: LocalExportObjectStoreOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.rootDirectory !== 'string' ||
      options.rootDirectory.trim() === ''
    ) {
      throw new Error('export-storage-root-required');
    }
    this.rootDirectory = options.rootDirectory;
  }

  async storeArtifact(
    command: ExportStoreCommand,
  ): Promise<ExportStorageOutcome> {
    const exportId = requireSafeArtifactIdentity(
      command?.exportId,
      'export-id',
    );
    if (typeof command.kind !== 'string' || command.kind.trim() === '') {
      throw new Error('export-storage-kind-required');
    }
    if (typeof command.format !== 'string' || command.format.trim() === '') {
      throw new Error('export-storage-format-required');
    }
    if (
      !(command.content instanceof Uint8Array) ||
      command.content.length === 0
    ) {
      return {
        outcome: 'DECLINED',
        declineReason: 'export-storage-empty-artifact',
      };
    }
    if (!(await this.rootIsReady())) {
      return {
        outcome: 'DECLINED',
        declineReason: 'export-storage-root-missing',
      };
    }

    const artifactPath = join(this.rootDirectory, exportId);
    const manifestPath = `${artifactPath}.manifest.json`;
    const manifestFacts: ArtifactManifestFacts = {
      exportId,
      kind: command.kind,
      format: command.format,
      byteLength: command.content.length,
    };

    const alreadyBound = await this.readPublishedPath(
      artifactPath,
      'artifact-path-not-regular',
    );
    if (alreadyBound !== null) {
      if (!artifactBytesEqual(alreadyBound, command.content)) {
        throw new Error('export-storage-collision');
      }
      const converged = await this.ensureManifestAndReport(
        manifestPath,
        manifestFacts,
      );
      await this.trySyncDirectoryBestEffort();
      return converged;
    }

    const tempArtifactPath = `${artifactPath}.tmp-${randomUUID()}`;
    let publishedByThisCall: boolean;
    try {
      await writeFile(tempArtifactPath, command.content);
      await syncFile(tempArtifactPath);
      try {
        await link(tempArtifactPath, artifactPath);
        publishedByThisCall = true;
      } catch (error) {
        if (!isOccupied(error)) {
          throw error;
        }
        publishedByThisCall = false;
      }
    } finally {
      await unlink(tempArtifactPath).catch(() => undefined);
    }

    const published = await this.readPublishedPath(
      artifactPath,
      'artifact-path-not-regular',
    );
    if (published === null) {
      return { outcome: 'UNKNOWN_EFFECT' };
    }
    if (!artifactBytesEqual(published, command.content)) {
      if (publishedByThisCall) {
        return { outcome: 'UNKNOWN_EFFECT' };
      }

      throw new Error('export-storage-collision');
    }
    const stored = await this.ensureManifestAndReport(
      manifestPath,
      manifestFacts,
    );
    await this.trySyncDirectoryBestEffort();
    return stored;
  }

  private async rootIsReady(): Promise<boolean> {
    try {
      const info = await stat(this.rootDirectory);
      return info.isDirectory();
    } catch (error) {
      if (isRootAbsent(error)) {
        return false;
      }

      throw error;
    }
  }

  private async trySyncDirectoryBestEffort(): Promise<void> {
    try {
      const handle = await open(this.rootDirectory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      return;
    }
  }

  private async readPublishedPath(
    finalPath: string,
    notRegularLabel: string,
  ): Promise<Uint8Array | null> {
    const info = await lstat(finalPath).catch((error: unknown) => {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    });
    if (info === null) {
      return null;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`export-storage-${notRegularLabel}`);
    }
    return readFile(finalPath);
  }

  private async ensureManifestAndReport(
    manifestPath: string,
    expected: ArtifactManifestFacts,
  ): Promise<ExportStorageOutcome> {
    const rawManifest = await this.readPublishedPath(
      manifestPath,
      'manifest-path-not-regular',
    );
    if (rawManifest !== null) {
      const parsed = manifestOrNull(rawManifest);
      if (
        parsed === null ||
        parsed.exportId !== expected.exportId ||
        parsed.kind !== expected.kind ||
        parsed.format !== expected.format ||
        parsed.byteLength !== expected.byteLength
      ) {
        throw new Error('export-storage-manifest-conflict');
      }
      return {
        outcome: 'STORED',
        storageRef: expected.exportId,
        byteLength: expected.byteLength,
      };
    }

    const tempManifestPath = `${manifestPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(tempManifestPath, JSON.stringify(expected));
      await syncFile(tempManifestPath);
      try {
        await link(tempManifestPath, manifestPath);
      } catch (error) {
        if (!isOccupied(error)) {
          throw error;
        }

        const converged = await this.readPublishedPath(
          manifestPath,
          'manifest-path-not-regular',
        );
        const parsed = converged === null ? null : manifestOrNull(converged);
        if (
          parsed === null ||
          parsed.exportId !== expected.exportId ||
          parsed.kind !== expected.kind ||
          parsed.format !== expected.format ||
          parsed.byteLength !== expected.byteLength
        ) {
          throw new Error('export-storage-manifest-conflict');
        }
      }
    } finally {
      await unlink(tempManifestPath).catch(() => undefined);
    }
    return {
      outcome: 'STORED',
      storageRef: expected.exportId,
      byteLength: expected.byteLength,
    };
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT';
}

function isRootAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isOccupied(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'EEXIST';
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|\b)/i;

const CLOCK_RESERVED_NAME = /^clock\$/i;

function artifactBytesEqual(
  durable: Uint8Array,
  produced: Uint8Array,
): boolean {
  if (durable.length !== produced.length) {
    return false;
  }
  for (let i = 0; i < durable.length; i += 1) {
    if (durable[i] !== produced[i]) {
      return false;
    }
  }
  return true;
}

function requireSafeArtifactIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`export-storage-${label}-required`);
  }

  if (
    value === '.' ||
    value.length > 120 ||
    /[/\\:]/.test(value) ||
    value.includes('..') ||
    value.includes('.tmp-') ||
    value.endsWith('.manifest.json') ||
    /[.\s]$/.test(value) ||
    hasControlCharacter(value) ||
    WINDOWS_RESERVED_NAME.test(value) ||
    CLOCK_RESERVED_NAME.test(value)
  ) {
    throw new Error(`export-storage-${label}-unsafe-identity`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function syncFile(path: string): Promise<void> {
  return open(path, 'r+').then(async (handle) => {
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

function manifestOrNull(raw: Uint8Array): ArtifactManifestFacts | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.exportId !== 'string' ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.format !== 'string' ||
      typeof parsed.byteLength !== 'number' ||
      !Number.isSafeInteger(parsed.byteLength)
    ) {
      return null;
    }
    return {
      exportId: parsed.exportId,
      kind: parsed.kind,
      format: parsed.format,
      byteLength: parsed.byteLength,
    };
  } catch {
    return null;
  }
}
