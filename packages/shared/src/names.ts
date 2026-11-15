const ADJECTIVES = [
  "Swift", "Quiet", "Prime", "Rapid", "Sharp", "Steady", "Bold", "Clever", "Lucky", "Brisk",
  "Nimble", "Calm", "Keen", "Lunar", "Solar", "Amber", "Cobalt", "Crimson", "Silver", "Golden",
  "Atomic", "Binary", "Cosmic", "Polar", "Velvet", "Iron", "Copper", "Misty", "Stormy", "Frosty",
];
const NOUNS = [
  "Otter", "Falcon", "Lynx", "Comet", "Quokka", "Heron", "Badger", "Raven", "Panda", "Fox",
  "Orca", "Gecko", "Bison", "Koala", "Moose", "Tiger", "Wolf", "Mantis", "Puffin", "Ibex",
  "Sigma", "Delta", "Vector", "Matrix", "Integer", "Prime", "Radix", "Tensor", "Scalar", "Quant",
];

export function suggestUsername(random: () => number = Math.random): string {
  const a = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)]!;
  let n = NOUNS[Math.floor(random() * NOUNS.length)]!;
  if (n === a) n = "Quant";
  const num = Math.floor(random() * 90) + 10;
  return `${a}${n}${num}`;
}

export const USERNAME_RULE = "3–20 characters: letters, numbers, underscores or hyphens.";
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const BLOCKED = ["admin", "moderator", "quantmaxxing", "system", "support", "nigg", "fag", "rape", "hitler", "nazi"];

export function validateUsername(name: unknown): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== "string") return { ok: false, reason: USERNAME_RULE };
  const trimmed = name.trim();
  if (!USERNAME_RE.test(trimmed)) return { ok: false, reason: USERNAME_RULE };
  const lower = trimmed.toLowerCase();
  if (BLOCKED.some((b) => lower.includes(b))) return { ok: false, reason: "That username isn't available." };
  return { ok: true, name: trimmed };
}
