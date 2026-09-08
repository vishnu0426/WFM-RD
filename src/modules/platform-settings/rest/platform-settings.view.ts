import { PlatformSettings } from '../entities/platform-settings.entity';

/**
 * `smtpPassword` is a real plaintext credential, so — same reasoning as
 * `TenantSettingsView` — it's never returned from any API response.
 */
export type PlatformSettingsView = Omit<PlatformSettings, 'smtpPassword'> & {
  smtpPasswordSet: boolean;
};

export function toPlatformSettingsView(settings: PlatformSettings): PlatformSettingsView {
  const { smtpPassword, ...rest } = settings;
  return { ...rest, smtpPasswordSet: !!smtpPassword };
}
