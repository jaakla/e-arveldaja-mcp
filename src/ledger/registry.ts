/**
 * Ledger backend registry.
 *
 * Wires the available LedgerConnector adapters and selects between them. The
 * host backend (e-arveldaja) is always present because it reuses the active
 * connection's ApiContext. Merit is added only when MERIT_API_ID/KEY are set,
 * so an unconfigured Merit is reported as "available but not configured"
 * rather than throwing.
 *
 * Default backend: EARVELDAJA_LEDGER_DEFAULT_BACKEND, else "e-arveldaja".
 */
import type { ApiContext } from "../tools/crud/shared.js";
import type { Capabilities, LedgerConnector } from "./port.js";
import { EarveldajaAdapter } from "./earveldaja/adapter.js";
import { MeritAdapter } from "./merit/adapter.js";
import { MeritHttpClient } from "./merit/http.js";
import { getMeritConfig } from "./merit/config.js";

export interface BackendInfo {
  backendId: string;
  label: string;
  configured: boolean;
  isDefault: boolean;
  capabilities?: Capabilities;
  note?: string;
}

export interface LedgerRegistry {
  /** Connectors that are actually usable right now (configured). */
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
): LedgerRegistry {
  const connectors = new Map<string, LedgerConnector>();

  // Host backend — always available.
  const earveldaja = new EarveldajaAdapter(api);
  connectors.set(earveldaja.capabilities.backendId, earveldaja);

  // Merit — only when configured.
  let meritConfigured = false;
  const meritConfig = getMeritConfig(env);
  if (meritConfig) {
    connectors.set("merit", new MeritAdapter(new MeritHttpClient(meritConfig)));
    meritConfigured = true;
  }

  const requestedDefault = env.EARVELDAJA_LEDGER_DEFAULT_BACKEND?.trim();
  const defaultBackend =
    requestedDefault && connectors.has(requestedDefault)
      ? requestedDefault
      : earveldaja.capabilities.backendId;

  return {
    connectors,
    defaultBackend,
    get(backendId?: string) {
      return connectors.get(backendId ?? defaultBackend);
    },
    list(): BackendInfo[] {
      const infos: BackendInfo[] = [
        {
          backendId: earveldaja.capabilities.backendId,
          label: earveldaja.capabilities.label,
          configured: true,
          isDefault: defaultBackend === earveldaja.capabilities.backendId,
          capabilities: earveldaja.capabilities,
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
