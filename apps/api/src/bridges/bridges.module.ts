import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { DeliveryService } from './delivery.service';
import { DatabaseSinkService } from './database-sink.service';
import { BridgeSinkService } from './bridge-sink.service';
import { BridgeJobProcessor } from './bridge-job.processor';
import { BridgeJobService } from './bridge-job.service';
import { BridgeCdcService } from './bridge-cdc.service';
import { BridgeLifecycleService } from './bridge-lifecycle.service';
import { BridgeStoreService } from './bridge-store.service';
import { BridgeWatchProcessor } from './bridge-watch.processor';
import { CdcSpoolService } from './cdc/cdc-spool.service';
import { BridgeWatchService } from './bridge-watch.service';
import { BridgesController } from './bridges.controller';
import { JobRegistryService } from './job-registry.service';
import { BRIDGE_JOBS_QUEUE, BRIDGE_WATCH_QUEUE } from './bridges.types';
import { CDC_PROVIDERS, type CdcProvider } from './cdc/cdc-provider';
import { PostgresCdcProvider } from './cdc/providers/postgres-cdc.provider';
import { MysqlCdcProvider } from './cdc/providers/mysql-cdc.provider';
import { MongodbCdcProvider } from './cdc/providers/mongodb-cdc.provider';
import { RedisCdcProvider } from './cdc/providers/redis-cdc.provider';
import { SqliteCdcProvider } from './cdc/providers/sqlite-cdc.provider';

@Module({
  imports: [
    ConnectionsModule, // AdapterPoolService
    BullModule.registerQueue({ name: BRIDGE_JOBS_QUEUE }),
    BullModule.registerQueue({ name: BRIDGE_WATCH_QUEUE }),
  ],
  controllers: [BridgesController],
  providers: [
    BridgeStoreService,
    BridgeJobService,
    BridgeWatchService,
    BridgeCdcService,
    BridgeLifecycleService,
    DeliveryService,
    DatabaseSinkService,
    BridgeSinkService,
    JobRegistryService,
    BridgeJobProcessor,
    BridgeWatchProcessor,
    CdcSpoolService,
    // CDC providers (one per engine) plus the aggregate the orchestrator injects
    PostgresCdcProvider,
    MysqlCdcProvider,
    MongodbCdcProvider,
    RedisCdcProvider,
    SqliteCdcProvider,
    {
      provide: CDC_PROVIDERS,
      inject: [
        PostgresCdcProvider,
        MysqlCdcProvider,
        MongodbCdcProvider,
        RedisCdcProvider,
        SqliteCdcProvider,
      ],
      useFactory: (...providers: CdcProvider[]): CdcProvider[] => providers,
    },
  ],
  // exported so WorkspacesModule can stop a workspace's live bridges on delete
  exports: [BridgeStoreService, BridgeWatchService, BridgeCdcService, BridgeLifecycleService],
})
export class BridgesModule {}
