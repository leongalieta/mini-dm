export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesKeyword(text, keyword) {
  const haystack = normalize(text);
  const needle = normalize(keyword);
  if (!needle) return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`);
  return re.test(haystack);
}

export function ruleChannels(rule) {
  const channel = rule?.channel || "comment";
  if (channel === "both") return ["comment", "dm"];
  return [channel];
}

export function matchRule(text, rules = [], channel = "comment") {
  for (const rule of rules) {
    if (!rule.active) continue;
    if (!ruleChannels(rule).includes(channel)) continue;
    for (const keyword of rule.keywords || []) {
      if (matchesKeyword(text, keyword)) {
        return { rule, keyword: String(keyword).trim() };
      }
    }
  }
  return null;
}

export function render(template, ctx = {}) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = ctx[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
