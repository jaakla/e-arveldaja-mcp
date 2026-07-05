/**
 * Ledger backend registry.
 *
 * Wires the available LedgerConnector adapters and selects between them. The
 * host backend (e-arveldaja) is always present because it reuses the active
 * connection's ApiContext. Merit is added only when MERIT_API_ID/KEY are set,
 * so an unconfigured Merit is reported as "available but not configured"
 * rather than throwing.
 *
 * Credential honesty: e-arveldaja's connector is always constructed (the write
 * tools rely on it), but `earveldajaConfigured` controls whether discovery
 * reports it as usable. When e-arveldaja has no credentials (the server runs in
 * setup mode), a configured Merit becomes the default backend so unqualified
 * `ledger_*` calls do not route into an unconfigured e-arveldaja.
 *
 * Default backend resolution:
 *   1. EARVELDAJA_LEDGER_DEFAULT_BACKEND, if it names a registered backend
 *   2. e-arveldaja, if it is configured
 *   3. the first other configured backend (e.g. merit)
 *   4. e-arveldaja (last resort, even if unconfigured)
 */
import type { ApiContext } from "../tools/crud/shared.js";
import type { Capabilities, LedgerConnector } from "./port.js";
import { EarveldajaAdapter } from "./earveldaja/adapter.js";
import { MeritAdapter } from "./merit/adapter.js";
import { MeritHttpClient } from "./merit/http.js";
import { getMeritConfig } from "./merit/config.js";

const EARVELDAJA = "e-arveldaja";

export interface BackendInfo {
  backendId: string;
  label: string;
  configured: boolean;
  isDefault: boolean;
  capabilities?: Capabilities;
  note?: string;
}

export interface BuildRegistryOptions {
  /**
   * Whether the e-arveldaja backend has usable credentials. Defaults to true
   * (the write-tool path always has an active connection). Pass `false` from
   * the server when it is in setup mode so discovery and default-backend
   * selection reflect reality.
   */
  earveldajaConfigured?: boolean;
}

export interface LedgerRegistry {
  /** All constructed connectors (e-arveldaja is always present). */
  readonly connectors: Map<string, LedgerConnector>;
  readonly defaultBackend: string;
  /** Discovery output for the list_ledger_backends tool. */
  list(): BackendInfo[];
  /** Resolve a connector by id, or the default when id is omitted. */
  get(backendId?: string): LedgerConnector | undefined;
}

export function buildLedgerRegistry(
  api: ApiContext,
  env: NodeJS.ProcessEnv = process.env,
  opts: BuildRegistryOptions = {},
): LedgerRegistry {
  const earveldajaConfigured = opts.earveldajaConfigured ?? true;
  const connectors = new Map<string, LedgerConnector>();

  // Host backend — always constructed (write tools depend on it). Whether it is
  // actually usable is governed by `earveldajaConfigured`.
  const earveldaja = new EarveldajaAdapter(api);
  connectors.set(EARVELDAJA, earveldaja);

  // Merit — only when credentials are present.
  const meritConfig = getMeritConfig(env);
  const meritConfigured = meritConfig !== null;
  if (meritConfig) {
    connectors.set("merit", new MeritAdapter(new MeritHttpClient(meritConfig)));
  }

  const defaultBackend = resolveDefault(env, connectors, earveldajaConfigured);

  return {
    connectors,
    defaultBackend,
    get(backendId?: string) {
      return connectors.get(backendId ?? defaultBackend);
    },
    list(): BackendInfo[] {
      const infos: BackendInfo[] = [
        {
          backendId: EARVELDAJA,
          label: earveldaja.capabilities.label,
          configured: earveldajaConfigured,
          isDefault: defaultBackend === EARVELDAJA,
          capabilities: earveldaja.capabilities,
          ...(earveldajaConfigured
            ? {}
            : { note: "No e-arveldaja credentials found — server is in setup mode. Add apikey*.txt / .env, or use a configured backend below." }),
        },
      ];
      const merit = connectors.get("merit");
      infos.push(
        meritConfigured && merit
          ? {
              backendId: "merit",
              label: merit.capabilities.label,
              configured: true,
              isDefault: defaultBackend === "merit",
              capabilities: merit.capabilities,
            }
          : {
              backendId: "merit",
              label: "Merit Aktiva",
              configured: false,
              isDefault: false,
              note: "Set MERIT_API_ID and MERIT_API_KEY (and optionally MERIT_API_COUNTRY=EE|PL) to enable.",
            },
      );
      return infos;
    },
  };
}

function resolveDefault(
  env: NodeJS.ProcessEnv,
  connectors: Map<string, LedgerConnector>,
  earveldajaConfigured: boolean,
): string {
  const requested = env.EARVELDAJA_LEDGER_DEFAULT_BACKEND?.trim();
  if (requested && connectors.has(requested)) return requested;
  if (earveldajaConfigured) return EARVELDAJA;
  // e-arveldaja unconfigured: prefer the first other configured backend.
  for (const id of connectors.keys()) {
    if (id !== EARVELDAJA) return id;
  }
  return EARVELDAJA;
}
