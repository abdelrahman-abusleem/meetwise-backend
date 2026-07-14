import { Controller, Get, Post } from '@nestjs/common';
import { ApiService } from './api.service';
import { SystemQueueService } from './services/system-queue.service';

@Controller()
export class ApiController {
  constructor(
    private readonly apiService: ApiService,
    private readonly systemQueueService: SystemQueueService,
  ) {}

  @Get()
  getHello(): string {
    return this.apiService.getHello();
  }

  @Post('system/smoke-test')
  async enqueueSmokeTest(): Promise<{ jobId: string }> {
    const jobId = await this.systemQueueService.enqueueSmokeTest();

    return { jobId };
  }
}
