// Type-only import: erased at compile time so importing this module never
// triggers loading the @llamaindex/liteparse native binary. The native module
// (a Rust addon bundling PDFium) is loaded lazily on first OCR use — see
// getDocumentParser — so the server boots on platforms where the binary cannot
// load (e.g. glibc < 2.38, musl/Alpine), with OCR failing only when invoked
// rather than crashing the whole server at startup.
import type { LiteParse, LiteParseConfig, ParseResult } from "@llamaindex/liteparse";

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function validateOcrUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(
        `EARVELDAJA_LITEPARSE_OCR_SERVER_URL must use https, or http only for a local loopback OCR server, got: ${parsed.protocol}`
      );
    }
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error(
        "EARVELDAJA_LITEPARSE_OCR_SERVER_URL must use https for remote OCR servers. " +
        "Plain http is only allowed for localhost / loopback OCR services."
      );
    }
    return url;
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`EARVELDAJA_LITEPARSE_OCR_SERVER_URL is not a valid URL: ${url}`);
    }
    throw err;
  }
}

interface ParsedDocument {
  text: string;
  pageCount: number;
  result: ParseResult;
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value !== "0" && value.toLowerCase() !== "false";
}

function readNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildDocumentParserConfig(): Partial<LiteParseConfig> {
  const config: Partial<LiteParseConfig> = {
    // Most invoices here are Estonian/English. LiteParse's built-in Tesseract
    // supports multi-language strings like "eng+est".
    ocrEnabled: readBooleanEnv("EARVELDAJA_LITEPARSE_OCR_ENABLED", true),
    ocrLanguage: process.env.EARVELDAJA_LITEPARSE_OCR_LANGUAGE ?? "eng+est",
    ocrServerUrl: validateOcrUrl(process.env.EARVELDAJA_LITEPARSE_OCR_SERVER_URL),
    outputFormat: "text",
    preserveVerySmallText: true,
  };

  const numWorkers = readNumberEnv("EARVELDAJA_LITEPARSE_NUM_WORKERS");
  if (numWorkers !== undefined) config.numWorkers = numWorkers;

  const maxPages = readNumberEnv("EARVELDAJA_LITEPARSE_MAX_PAGES");
  if (maxPages !== undefined) config.maxPages = maxPages;

  return config;
}

/**
 * Dynamically load the liteparse native module, turning its cryptic native
 * loader failure into an actionable error. Only called when OCR is actually
 * used, so an unsupported platform does not prevent the server from booting.
 */
async function loadLiteParse(): Promise<typeof import("@llamaindex/liteparse")> {
  try {
    return await import("@llamaindex/liteparse");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Document OCR is unavailable on this platform: the @llamaindex/liteparse native module " +
      "could not be loaded. It requires a supported platform — macOS (arm64/x64), Linux x64/arm64 " +
      "with glibc ≥ 2.38, or Windows x64; musl/Alpine is unsupported. The rest of the server " +
      `(including non-OCR and ledger tools) is unaffected. Underlying error: ${detail}`,
    );
  }
}

// Cache the parser promise so the native module is imported and the parser
// constructed at most once. A cached rejection is fine: a platform that cannot
// load the binary will not start being able to mid-process.
let parserPromise: Promise<LiteParse> | undefined;

export async function getDocumentParser(): Promise<LiteParse> {
  parserPromise ??= loadLiteParse().then(({ LiteParse }) => new LiteParse(buildDocumentParserConfig()));
  return parserPromise;
}

export async function parseDocument(filePath: string): Promise<ParsedDocument> {
  const parser = await getDocumentParser();
  const result = await parser.parse(filePath);
  return {
    text: result.text,
    pageCount: result.pages.length,
    result,
  };
}
