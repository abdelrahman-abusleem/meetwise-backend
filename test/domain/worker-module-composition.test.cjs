const test = require('node:test');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { Module } = require('@nestjs/common');
const {
  ExportGenerationModule,
  NotificationDeliveryModule,
} = require('../../libs/meetings/src/infrastructure/nest/worker-composition.module.ts');
const {
  ExportRequestService,
} = require('../../libs/meetings/src/application/export-request.service.ts');
const {
  ExportGenerationService,
} = require('../../libs/meetings/src/application/export-generation.service.ts');
const {
  ExportGenerationWorkerRuntime,
} = require('../../libs/meetings/src/infrastructure/export/export-generation-worker.ts');
const {
  NotificationDeliveryService,
} = require('../../libs/meetings/src/application/notification-delivery.service.ts');
const {
  NotificationDeliveryWorkerRuntime,
} = require('../../libs/meetings/src/infrastructure/notification/notification-delivery-worker.ts');

const exportMethods = [
  'getExportRequestFacts',
  'createExportJob',
  'getWorkerFacts',
  'claimExportForProcessing',
  'reportExportCompletion',
  'getReadAccessFacts',
  'getDownloadAccessFacts',
  'recordDownloadAudit',
];
const generationMethods = [
  'findInboxOutcome',
  'writeInboxOutcome',
  'loadSourceFacts',
];
const deliveryMethods = [
  'findInboxOutcome',
  'writeInboxOutcome',
  'loadNotificationRow',
  'loadRecipientContact',
  'readChannelAttempts',
  'reserveAttempt',
  'settleAttempt',
];
function ports(methods) {
  return Object.fromEntries(
    methods.map((name) => [
      name,
      async () => {
        throw new Error('unexpected-port-call');
      },
    ]),
  );
}
function exportConfig() {
  return {
    requestRepository: ports(exportMethods),
    repository: ports(generationMethods),
    storeRoot: 'Z:/unprovisioned-synthetic-export-root',
  };
}
function deliveryConfig() {
  return {
    repository: ports(deliveryMethods),
    transporter: {
      async sendMail() {
        throw new Error('unexpected-smtp');
      },
    },
    queue: {
      async add() {
        throw new Error('unexpected-redis');
      },
    },
    fromAddress: 'synthetic@example.invalid',
    retryJobName: 'synthetic-delivery',
    retryPolicy: null,
  };
}
for (const [name, FeatureModule, configFactory, worker, service] of [
  [
    'export',
    ExportGenerationModule,
    exportConfig,
    ExportGenerationWorkerRuntime,
    ExportGenerationService,
  ],
  [
    'notification',
    NotificationDeliveryModule,
    deliveryConfig,
    NotificationDeliveryWorkerRuntime,
    NotificationDeliveryService,
  ],
]) {
  test(`${name}: async factory resolves imported binding once and exports a shared graph`, async () => {
    const binding = Symbol('synthetic-config');
    class BindingsModule {}
    Module({
      providers: [{ provide: binding, useValue: configFactory() }],
      exports: [binding],
    })(BindingsModule);
    let factories = 0;
    const configured = FeatureModule.registerAsync({
      imports: [BindingsModule],
      inject: [binding],
      useFactory: async (config) => {
        factories++;
        return config;
      },
    });
    class Consumer {}
    const consumer = {
      provide: Consumer,
      inject: [worker, service],
      useFactory: (runtime, application) => ({ runtime, application }),
    };
    const container = await Test.createTestingModule({
      imports: [configured],
      providers: [consumer],
    }).compile();
    try {
      await container.init();
      assert.equal(factories, 1);
      assert.equal(container.get(Consumer).runtime, container.get(worker));
      assert.equal(container.get(Consumer).application, container.get(service));
      const first = await container.get(worker).runTurn(null);
      assert.equal(first.verdict, 'DEAD_LETTER');
      assert.equal(first.outcome.kind, 'REFUSED');
      assert.equal(container.get(worker), container.get(worker));
      const application = container.get(service);
      const method =
        name === 'export' ? 'processGenerationTurn' : 'processDeliveryTurn';
      const original = application[method];
      const fault = new Error('synthetic-service-fault');
      application[method] = async () => {
        throw fault;
      };
      try {
        await assert.rejects(
          container.get(worker).runTurn({}),
          (error) => error === fault,
        );
      } finally {
        application[method] = original;
      }
      if (name === 'export')
        assert.ok(
          container.get(ExportRequestService) instanceof ExportRequestService,
        );
    } finally {
      await container.close();
    }
  });
  test(`${name}: missing imported dependency prevents startup`, async () => {
    await assert.rejects(
      Test.createTestingModule({
        imports: [
          FeatureModule.registerAsync({
            inject: [Symbol('missing-binding')],
            useFactory: (config) => config,
          }),
        ],
      }).compile(),
    );
  });
  for (const bad of [null, undefined, {}])
    test(`${name}: absent configuration fails closed`, async () => {
      await assert.rejects(
        Test.createTestingModule({
          imports: [FeatureModule.registerAsync({ useFactory: () => bad })],
        }).compile(),
        /worker-composition/,
      );
    });
}
for (const [key, methods] of [
  ['requestRepository', exportMethods],
  ['repository', generationMethods],
]) {
  for (const method of methods)
    test(`export: missing ${key}.${method} fails before any IO`, async () => {
      const config = exportConfig();
      delete config[key][method];
      await assert.rejects(
        Test.createTestingModule({
          imports: [
            ExportGenerationModule.registerAsync({ useFactory: () => config }),
          ],
        }).compile(),
        /worker-composition/,
      );
    });
}
for (const method of deliveryMethods)
  test(`notification: missing repository.${method} fails before any IO`, async () => {
    const config = deliveryConfig();
    delete config.repository[method];
    await assert.rejects(
      Test.createTestingModule({
        imports: [
          NotificationDeliveryModule.registerAsync({
            useFactory: () => config,
          }),
        ],
      }).compile(),
      /worker-composition/,
    );
  });
for (const key of ['transporter', 'queue', 'retryPolicy'])
  test(`notification: missing ${key} fails without defaults`, async () => {
    const config = deliveryConfig();
    delete config[key];
    await assert.rejects(
      Test.createTestingModule({
        imports: [
          NotificationDeliveryModule.registerAsync({
            useFactory: () => config,
          }),
        ],
      }).compile(),
      /worker-composition/,
    );
  });
test('async binding failure preserves rejection and never substitutes a fake dependency', async () => {
  const fault = new Error('synthetic-binding-unavailable');
  await assert.rejects(
    Test.createTestingModule({
      imports: [
        NotificationDeliveryModule.registerAsync({
          useFactory: async () => {
            throw fault;
          },
        }),
      ],
    }).compile(),
    (error) => error === fault,
  );
});

test('export worker reaches the exported request service through its existing generation graph', async () => {
  const config = exportConfig();
  let reads = 0;
  config.repository.findInboxOutcome = async () => {
    reads++;
    return null;
  };
  const container = await Test.createTestingModule({
    imports: [
      ExportGenerationModule.registerAsync({ useFactory: () => config }),
    ],
  }).compile();
  try {
    const request = container.get(ExportRequestService);
    const original = request.claimForProcessing;
    const fault = new Error('synthetic-request-service-fault');
    request.claimForProcessing = async () => {
      throw fault;
    };
    try {
      await assert.rejects(
        container.get(ExportGenerationWorkerRuntime).runTurn({
          eventId: 'synthetic-event',
          exportId: 'synthetic-export',
          processedAt: '2026-11-03T00:00:00Z',
        }),
        (error) => error === fault,
      );
      assert.equal(reads, 1);
    } finally {
      request.claimForProcessing = original;
    }
  } finally {
    await container.close();
  }
});
