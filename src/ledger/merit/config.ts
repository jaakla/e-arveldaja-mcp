/**
 * Merit Aktiva credentials & base URL, loaded from the environment.
 *
 *   MERIT_API_ID       GUID from Merit → Company data → API settings
 *   MERIT_API_KEY      base64-looking secret (the HMAC signing key, used verbatim)
 *   MERIT_API_COUNTRY  "EE" (default) or "PL" — selects the regional host
 *
 * Returns null when not configured, so the registry can report Merit as an
 * available-but-unconfigured backend instead of throwing at startup.
 */
export interface MeritConfig {
  apiId: string;
  apiKey: string;
  baseUrl: string;
  country: "EE" | "PL";
}

const HOSTS: Record<"EE" | "PL", string> = {
  EE: "https://aktiva.merit.ee",
  // Merit's Polish product is 360 Księgowość (host verified against the
  // jaakla/merit_api reference client).
  PL: "https://program.360ksiegowosc.pl",
};

export function getMeritConfig(env: NodeJS.ProcessEnv = process.env): MeritConfig | null {
  const apiId = env.MERIT_API_ID?.trim();
  const apiKey = env.MERIT_API_KEY?.trim();
  if (!apiId || !apiKey) return null;
  const country = (env.MERIT_API_COUNTRY?.trim().toUpperCase() as "EE" | "PL") || "EE";
  if (country !== "EE" && country !== "PL") {
    throw new Error(`Invalid MERIT_API_COUNTRY="${country}". Must be "EE" or "PL".`);
  }
  return { apiId, apiKey, baseUrl: HOSTS[country], country };
}
