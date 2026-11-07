import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { ActivateLicenseDto } from './dto/activate-license.dto';
import { LicenseService } from './license.service';

@Controller('system/license')
export class LicenseController {
  constructor(private readonly licenseService: LicenseService) {}

  @Get('status')
  getCurrentStatus() {
    return this.licenseService.getCurrentStatus();
  }

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  activate(@Body() dto: ActivateLicenseDto) {
    return this.licenseService.activate(dto.licenseKey);
  }
}
