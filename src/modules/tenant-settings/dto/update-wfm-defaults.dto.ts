import { IsIn, IsOptional, Matches } from 'class-validator';

const WEEK_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** `PUT /v1/tenant-settings/wfm-defaults` (and its cross-tenant counterpart, `TenantManagementController.updateWfmDefaults`) — partial update. */
export class UpdateWfmDefaultsDto {
  @IsOptional()
  @IsIn(WEEK_DAYS)
  weekStartDay?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, { message: 'dayBoundary must be HH:MM or HH:MM:SS' })
  dayBoundary?: string;
}
