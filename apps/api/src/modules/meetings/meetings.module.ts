import { Module } from '@nestjs/common';
import { DatabaseModule } from '@meetwise/infrastructure/database';
import { AuthModule } from '../auth/auth.module';
import { MeetingsController } from './meetings.controller';
import { MeetingCreateService } from './meeting-create.service';
import { MeetingCreateStore } from './meeting-create.store';
import { MeetingReadService } from './meeting-read.service';
import { CancellationRequestService } from './cancellation-request.service';
import { CancellationRequestStore } from './cancellation-request.store';
import { CancellationDecisionsController } from './cancellation-decisions.controller';
import { CancellationDecisionService } from './cancellation-decision.service';
import { CancellationDecisionStore } from './cancellation-decision.store';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [MeetingsController, CancellationDecisionsController],
  providers: [
    MeetingCreateService,
    MeetingCreateStore,
    MeetingReadService,
    CancellationRequestService,
    CancellationRequestStore,
    CancellationDecisionService,
    CancellationDecisionStore,
  ],
})
export class MeetingsModule {}
