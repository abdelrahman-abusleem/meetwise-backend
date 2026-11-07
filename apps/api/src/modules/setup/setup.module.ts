import { SetupBootstrapGuard } from './setup-bootstrap.guard';
import { SetupTokenService } from './setup-token.service';
import { WizardDraftsController } from './wizard-drafts.controller';
import { WizardDraftsService } from './wizard-drafts.service';
import { WizardActivationController } from './wizard-activation.controller';
import { WizardActivationService } from './wizard-activation.service';
import { Module } from '@nestjs/common';

import { DatabaseModule } from '@meetwise/infrastructure/database';

import { AuthModule } from '../auth/auth.module';
import { SetupController } from './setup.controller';
import { SetupService } from './setup.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [
    SetupController,
    WizardDraftsController,
    WizardActivationController,
  ],
  providers: [
    SetupService,
    SetupTokenService,
    SetupBootstrapGuard,
    WizardDraftsService,
    WizardActivationService,
  ],
})
export class SetupModule {}
