<!-- Generated from workflows/setup-e-arveldaja.md. Edit that source file, then run npm run sync:workflow-prompts. -->

# Setup e-arveldaja

Explain how to configure e-arveldaja MCP credentials for the current working directory.

**Scope: e-arveldaja credentials only.** Other ledger backends are configured separately through environment variables (Merit Aktiva: `MERIT_API_ID`, `MERIT_API_KEY`, optional `MERIT_API_COUNTRY=EE|PL`) — check `list_ledger_backends` for what is configured. The server can also run Merit-only, without e-arveldaja credentials, as a ledger session.

For actual importing, prefer the `setup-credentials` workflow because it covers storage scope, append/overwrite behavior, removal, and restart verification.

Follow these steps:

1. Call `get_setup_instructions`.
2. Report whether the server is in `setup` or `configured` mode.
3. Explain the supported credential paths:
   - `EARVELDAJA_API_KEY_ID`
   - `EARVELDAJA_API_PUBLIC_VALUE`
   - `EARVELDAJA_API_PASSWORD`
   - `EARVELDAJA_API_KEY_FILE`
   - importing a secure `apikey*.txt` with `import_apikey_credentials`
4. If credentials need importing, use `import_apikey_credentials` only after the user identifies the file or confirms the detected single candidate.
5. After a successful import, state that the MCP server must be restarted before the stored credentials become active.
