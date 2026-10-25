// Runtime environment-var overrides set through the Settings page.
//
// Values set here take precedence over backend/.env; when a key has no override
// the process.env value (loaded from .env) is used as the fallback. Overrides
// live in memory only and are lost on server restart, at which point .env
// applies again -- which is exactly the intended "backup" behaviour.
const overrides = Object.create(null);
let setupComplete = false;

const MANAGED_KEYS = ['MONGODB_URI', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'];

export function getEffective(key) {
  return overrides[key] ?? process.env[key] ?? '';
}

export function getOverride(key) {
  return overrides[key];
}

export function setOverride(key, value) {
  if (!MANAGED_KEYS.includes(key)) return false;
  overrides[key] = value === undefined || value === null ? '' : String(value);
  return true;
}

export function removeOverride(key) {
  if (!MANAGED_KEYS.includes(key)) return false;
  delete overrides[key];
  return true;
}

export function clearOverrides() {
  for (const key of MANAGED_KEYS) delete overrides[key];
}

export function markSetupComplete(value = true) {
  setupComplete = Boolean(value);
}

export function isSetupComplete() {
  return setupComplete;
}

export function getAllEffective() {
  return {
    MONGODB_URI: getEffective('MONGODB_URI'),
    OPENROUTER_API_KEY: getEffective('OPENROUTER_API_KEY'),
    OPENROUTER_MODEL: getEffective('OPENROUTER_MODEL'),
  };
}