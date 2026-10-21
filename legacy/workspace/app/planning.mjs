export const PLANNING_KEY = 'bxagi.planning.v1';
export const defaultPlanning = () => ({
  count: 3,
  minDuration: 5,
  maxDuration: 45,
  strategy: 'hook',
  format: 'landscape',
  advancedOpen: false
});

/** Persist only valid nonsecret settings, outside the unchanged workspace v1 schema. */
export function validatePlanning(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = Number(raw.count),
    minDuration = Number(raw.minDuration),
    maxDuration = Number(raw.maxDuration);
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isFinite(minDuration) || !Number.isFinite(maxDuration) || minDuration < 1 || maxDuration < minDuration || maxDuration > 600) return null;
  if (!['hook', 'narrative', 'selling'].includes(raw.strategy) || !['landscape', 'portrait', 'square'].includes(raw.format)) return null;
  return {
    count,
    minDuration,
    maxDuration,
    strategy: raw.strategy,
    format: raw.format,
    advancedOpen: raw.advancedOpen === true
  };
}
export function createPlanningStore(storage) {
  let current = defaultPlanning();
  try {
    current = validatePlanning(JSON.parse(storage?.getItem(PLANNING_KEY))) || current;
  } catch {}
  return {
    get current() {
      return {
        ...current
      };
    },
    save(raw) {
      const checked = validatePlanning(raw);
      if (!checked) return false;
      current = checked;
      storage?.setItem(PLANNING_KEY, JSON.stringify(checked));
      return true;
    }
  };
}
