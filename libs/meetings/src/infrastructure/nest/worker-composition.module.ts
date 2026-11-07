import { Module } from '@nestjs/common';
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
} from '@nestjs/common';
import { ExportRequestService } from '../../application/export-request.service';
import type { ExportRequestRepository } from '../../application/export-request.repository';
import { ExportGenerationService } from '../../application/export-generation.service';
import { NotificationDeliveryService } from '../../application/notification-delivery.service';
import { composeExportGenerationCore } from '../export/export-generation-core';
import type { ExportGenerationCoreConfig } from '../export/export-generation-core';
import { ExportGenerationWorkerRuntime } from '../export/export-generation-worker';
import { composeNotificationDeliveryCore } from '../notification/notification-delivery-core';
import type { NotificationDeliveryCoreConfig } from '../notification/notification-delivery-core';
import { NotificationDeliveryWorkerRuntime } from '../notification/notification-delivery-worker';

export type WorkerBindingFactory<T> = Pick<
  FactoryProvider<T>,
  'useFactory' | 'inject'
> &
  Pick<ModuleMetadata, 'imports'>;

export interface ExportGenerationModuleConfig extends Omit<
  ExportGenerationCoreConfig,
  'exportService'
> {
  readonly requestRepository: ExportRequestRepository;
}

const EXPORT_CORE = Symbol('meetwise.export-generation.core');
const DELIVERY_CORE = Symbol('meetwise.notification-delivery.core');
type ExportCore = ReturnType<typeof composeExportGenerationCore> & {
  readonly exportService: ExportRequestService;
};
type DeliveryCore = ReturnType<typeof composeNotificationDeliveryCore>;

function requirePort(value: unknown, methods: readonly string[]): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    methods.some((method) => typeof Reflect.get(value, method) !== 'function')
  ) {
    throw new Error('worker-composition-port-binding-required');
  }
}

function exportCore(config: ExportGenerationModuleConfig): ExportCore {
  if (!config || typeof config !== 'object')
    throw new Error('worker-composition-export-config-required');
  requirePort(config.requestRepository, [
    'getExportRequestFacts',
    'createExportJob',
    'getWorkerFacts',
    'claimExportForProcessing',
    'reportExportCompletion',
    'getReadAccessFacts',
    'getDownloadAccessFacts',
    'recordDownloadAudit',
  ]);
  requirePort(config.repository, [
    'findInboxOutcome',
    'writeInboxOutcome',
    'loadSourceFacts',
  ]);
  const exportService = new ExportRequestService(config.requestRepository);
  return Object.freeze({
    ...composeExportGenerationCore({
      repository: config.repository,
      exportService,
      storeRoot: config.storeRoot,
    }),
    exportService,
  });
}

function deliveryCore(config: NotificationDeliveryCoreConfig): DeliveryCore {
  if (!config || typeof config !== 'object' || config.retryPolicy === undefined)
    throw new Error('worker-composition-delivery-config-required');
  requirePort(config.repository, [
    'findInboxOutcome',
    'writeInboxOutcome',
    'loadNotificationRow',
    'loadRecipientContact',
    'readChannelAttempts',
    'reserveAttempt',
    'settleAttempt',
  ]);
  requirePort(config.transporter, ['sendMail']);
  requirePort(config.queue, ['add']);
  return composeNotificationDeliveryCore(config);
}

@Module({})
export class ExportGenerationModule {
  static registerAsync(
    options: WorkerBindingFactory<ExportGenerationModuleConfig>,
  ): DynamicModule {
    const configToken = Symbol('meetwise.export-generation.config');
    return {
      module: ExportGenerationModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: configToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        { provide: EXPORT_CORE, inject: [configToken], useFactory: exportCore },
        {
          provide: ExportRequestService,
          inject: [EXPORT_CORE],
          useFactory: (core: ExportCore) => core.exportService,
        },
        {
          provide: ExportGenerationService,
          inject: [EXPORT_CORE],
          useFactory: (core: ExportCore) => core.service,
        },
        {
          provide: ExportGenerationWorkerRuntime,
          inject: [EXPORT_CORE],
          useFactory: (core: ExportCore) => core.worker,
        },
      ],
      exports: [
        ExportRequestService,
        ExportGenerationService,
        ExportGenerationWorkerRuntime,
      ],
    };
  }
}

@Module({})
export class NotificationDeliveryModule {
  static registerAsync(
    options: WorkerBindingFactory<NotificationDeliveryCoreConfig>,
  ): DynamicModule {
    const configToken = Symbol('meetwise.notification-delivery.config');
    return {
      module: NotificationDeliveryModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: configToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        {
          provide: DELIVERY_CORE,
          inject: [configToken],
          useFactory: deliveryCore,
        },
        {
          provide: NotificationDeliveryService,
          inject: [DELIVERY_CORE],
          useFactory: (core: DeliveryCore) => core.service,
        },
        {
          provide: NotificationDeliveryWorkerRuntime,
          inject: [DELIVERY_CORE],
          useFactory: (core: DeliveryCore) => core.worker,
        },
      ],
      exports: [NotificationDeliveryService, NotificationDeliveryWorkerRuntime],
    };
  }
}
