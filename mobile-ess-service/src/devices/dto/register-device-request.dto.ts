import { IsBoolean, IsEnum, IsString, IsUUID, MinLength } from 'class-validator';
import { DeviceType } from '../entities/device-registration.entity';

/**
 * `POST /v1/mobile/devices`'s request body (source spec §2.1/§3.1
 * `registerDevice`, ADR-0154). `employeeId` is client-supplied but no
 * longer unverified - `DevicesController` checks it against the caller's
 * own session before registering (ADR-0150/ADR-0157).
 */
export class RegisterDeviceRequestDto {
  @IsUUID()
  employeeId!: string;

  @IsEnum(DeviceType)
  deviceType!: DeviceType;

  /** ADR-0150/ADR-0157 (Module 11 Gap 2) - `mobile-app`'s stable per-install id (`getOrCreateDeviceId()`), the real disambiguator between two devices of the same employee/platform. */
  @IsString()
  @MinLength(1)
  deviceId!: string;

  @IsString()
  @MinLength(1)
  pushToken!: string;

  @IsString()
  @MinLength(1)
  appVersion!: string;

  /** The real backend home for `mobile-app/src/auth/biometric.ts`'s
   * already-documented local-only Phase 2 flag. */
  @IsBoolean()
  biometricEnrolled!: boolean;
}
