import { TenantSettings } from '../entities/tenant-settings.entity';

/**
 * `smtpPassword` is a real plaintext credential needed in full to
 * authenticate against the outbound mail server, so — same reasoning as
 * `TenantIdentityProviderView.oidcClientSecretSet` — it can never be
 * returned from any API response. Every other field here is plain
 * configuration, not a secret, and is returned as-is.
 */
export type TenantSettingsView = Omit<TenantSettings, 'smtpPassword'> & {
  smtpPasswordSet: boolean;
};

export function toTenantSettingsView(settings: TenantSettings): TenantSettingsView {
  const { smtpPassword, ...rest } = settings;
  return { ...rest, smtpPasswordSet: !!smtpPassword };
}
