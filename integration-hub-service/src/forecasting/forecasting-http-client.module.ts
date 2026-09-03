import { Module } from '@nestjs/common';
import { ForecastingHttpClientService } from './forecasting-http-client.service';

@Module({
  providers: [ForecastingHttpClientService],
  exports: [ForecastingHttpClientService],
})
export class ForecastingHttpClientModule {}
