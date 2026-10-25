import { AutomationSettings, DEFAULT_AUTOMATION_RULES } from '../models/AutomationSettings.js';

let databaseReady = false;
const memorySettings = new Map();
const RULE_NAMES = Object.keys(DEFAULT_AUTOMATION_RULES);

export function setAutomationDatabaseReady(value) {
  databaseReady = Boolean(value);
}

export function normalizeAutomationRules(value = {}) {
  return Object.fromEntries(RULE_NAMES.map((name) => [
    name,
    typeof value[name] === 'boolean' ? value[name] : DEFAULT_AUTOMATION_RULES[name]
  ]));
}

export async function getAutomationRules(boardId) {
  if (databaseReady) {
    const settings = await AutomationSettings.findOne({ boardId }).lean();
    return normalizeAutomationRules(settings?.rules);
  }
  return normalizeAutomationRules(memorySettings.get(String(boardId)));
}

export async function saveAutomationRules(boardId, updates) {
  const current = await getAutomationRules(boardId);
  const rules = { ...current, ...updates };
  if (databaseReady) {
    await AutomationSettings.findOneAndUpdate(
      { boardId: String(boardId) },
      { $set: { rules } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
  } else {
    memorySettings.set(String(boardId), rules);
  }
  return rules;
}

export function validateAutomationRuleUpdates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, enabled]) => !RULE_NAMES.includes(key) || typeof enabled !== 'boolean')) return null;
  return Object.fromEntries(entries);
}
