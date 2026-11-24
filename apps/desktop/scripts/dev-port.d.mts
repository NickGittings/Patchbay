// Types for `dev-port.mjs`, which `vite.config.ts` imports.
export const DEV_PORT_ENV: 'PATCHBAY_DEV_PORT'
export const DEFAULT_DEV_PORT: 1420
export function devPort(preferred?: number): Promise<number>
