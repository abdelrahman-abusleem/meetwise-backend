import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
} from '@nestjs/common';
import type { TranscriptEnvelope } from './transcript-envelope';
import { PostgresTranscriptConsumer } from './transcript-ingest.postgres';
import type { TranscriptTransactionRunner } from './transcript-ingest.postgres';

export interface TranscriptIngestBindings {
  readonly database: TranscriptTransactionRunner;
  readonly encryption: Pick<TranscriptEnvelope, 'open'>;
}
type TranscriptBindingFactory = Pick<
  FactoryProvider<TranscriptIngestBindings>,
  'useFactory' | 'inject'
> &
  Pick<ModuleMetadata, 'imports'>;
function compose(config: TranscriptIngestBindings): PostgresTranscriptConsumer {
  if (
    !config ||
    typeof config !== 'object' ||
    !config.database ||
    typeof config.database.$transaction !== 'function' ||
    !config.encryption ||
    typeof config.encryption.open !== 'function'
  )
    throw new Error('transcript-composition-binding-required');
  return new PostgresTranscriptConsumer(config.database, config.encryption);
}

@Module({})
export class TranscriptIngestModule {
  static registerAsync(options: TranscriptBindingFactory): DynamicModule {
    const configToken = Symbol('meetwise.transcript-ingest.bindings');
    return {
      module: TranscriptIngestModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: configToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: PostgresTranscriptConsumer,
          inject: [configToken],
          useFactory: compose,
        },
      ],
      exports: [PostgresTranscriptConsumer],
    };
  }
}
