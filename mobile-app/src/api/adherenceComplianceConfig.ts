export function getAdherenceComplianceApiBaseUrl(): string {
  const apiBaseUrl = process.env.EXPO_PUBLIC_ADHERENCE_COMPLIANCE_API_BASE_URL;
  if (!apiBaseUrl) {
    throw new Error('Missing EXPO_PUBLIC_ADHERENCE_COMPLIANCE_API_BASE_URL. Copy .env.example to .env.');
  }
  return apiBaseUrl;
}
