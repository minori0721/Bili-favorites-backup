export function isoToMs(value: unknown, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}


export function optionalIsoToMs(value: unknown) {
  const parsed = isoToMs(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}
