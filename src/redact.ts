export const MASK = "***";

const SECRET_KEY = /pass|pwd|secret|token|key|connectionstring|credential/i;

// Each rule keeps the label and masks the value.
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(Password|Pwd|AccountKey|SharedAccessKey|SecretAccessKey)\s*=\s*[^;\r\n"']+/gi, `$1=${MASK}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/(-(?:Password|Secret|Token|Key|Pat)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, `$1${MASK}$2`],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/(aws_secret\w*\s*[=:]\s*)[A-Za-z0-9/+=]{40}/gi, `$1${MASK}`],
  [/\b[a-z2-7]{52}\b/g, MASK], // Azure DevOps PAT shape
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep copy with secrets masked. Structural rules first, then pattern rules on every string. */
export function redactValue(v: unknown, parentKeyIsSecret = false): unknown {
  if (typeof v === "string") return parentKeyIsSecret ? MASK : redactString(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, false));
  if (!isObj(v)) return v;

  const out: Record<string, unknown> = {};
  const isSecretVar = v.isSecret === true;
  for (const [k, val] of Object.entries(v)) {
    if (isSecretVar && k === "value") {
      out[k] = MASK;
      continue;
    }
    const secretKey = SECRET_KEY.test(k);
    if (secretKey && isObj(val) && typeof val.value === "string") {
      // Variable named like a secret: {"DbPassword": {"value": "x"}}
      out[k] = { ...(redactValue(val) as Record<string, unknown>), value: MASK };
    } else {
      out[k] = redactValue(val, secretKey && typeof val === "string");
    }
  }
  return out;
}
