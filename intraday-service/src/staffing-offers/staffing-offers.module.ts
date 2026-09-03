import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StaffingOffer } from '../database/entities';
import { StaffingOfferService } from './staffing-offer.service';

/** Detection + push-trigger for VTO/overtime offers - see `StaffingOfferService`'s own doc comment for this pass's scope. */
@Module({
  imports: [TypeOrmModule.forFeature([StaffingOffer])],
  providers: [StaffingOfferService],
  exports: [StaffingOfferService],
})
export class StaffingOffersModule {}
