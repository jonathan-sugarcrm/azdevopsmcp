import { describe, expect, it } from "vitest";
import { MASK, redactString, redactValue } from "../src/redact.js";

describe("redactString", () => {
  const cases: Array<[string, string, string]> = [
    ["Password=", "Server=x;Password=hunter2;Db=y", "hunter2"],
    ["Pwd=", "pwd=hunter2", "hunter2"],
    ["AccountKey=", "AccountKey=abc123/+==;", "abc123"],
    ["SharedAccessKey=", "SharedAccessKey=zzz999", "zzz999"],
    ["Bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "eyJhbGci"],
    ["PowerShell -Password", "Install.ps1 -Password 'p@ss w0rd' -Name x", "p@ss w0rd"],
    ["PowerShell -Token", "run -Token abc123def", "abc123def"],
    ["URI credentials", "https://user:s3cret@host.example/path", "s3cret"],
    ["AWS key id", "key AKIAABCDEFGHIJKLMNOP end", "AKIAABCDEFGHIJKLMNOP"],
    ["AWS secret", "aws_secret_access_key=" + "A".repeat(40), "A".repeat(40)],
    ["AzDO PAT shape", "token " + "a".repeat(26) + "b".repeat(26), "a".repeat(26)],
  ];
  it.each(cases)("masks %s and cannot be recovered", (_n, input, secret) => {
    const out = redactString(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  });

  it("keeps the label", () => {
    expect(redactString("Password=hunter2")).toBe("Password=***");
  });

  it("leaves ordinary text alone", () => {
    const s = "Deploy Big Boy - Tabular Model step 3 of 7";
    expect(redactString(s)).toBe(s);
  });
});

describe("redactValue", () => {
  it("masks the value of a variable marked isSecret", () => {
    const out = redactValue({ variables: { Plain: { value: "ok" }, Hidden: { value: "topsecret", isSecret: true } } }) as any;
    expect(out.variables.Plain.value).toBe("ok");
    expect(out.variables.Hidden.value).toBe(MASK);
    expect(out.variables.Hidden.isSecret).toBe(true);
  });

  it("masks task inputs whose key looks secret", () => {
    const out = redactValue({ inputs: { Password: "p1", connectionString: "c1", scriptPath: "a.ps1" } }) as any;
    expect(out.inputs.Password).toBe(MASK);
    expect(out.inputs.connectionString).toBe(MASK);
    expect(out.inputs.scriptPath).toBe("a.ps1");
  });

  it("masks a variable named like a secret", () => {
    const out = redactValue({ variables: { DbPassword: { value: "x1" } } }) as any;
    expect(out.variables.DbPassword.value).toBe(MASK);
  });

  it("applies patterns inside nested strings and arrays", () => {
    const out = redactValue({ a: [{ cmd: "x Password=abc;" }] }) as any;
    expect(out.a[0].cmd).toBe("x Password=***;");
  });

  it("does not change the input", () => {
    const input = { variables: { H: { value: "v", isSecret: true } } };
    redactValue(input);
    expect(input.variables.H.value).toBe("v");
  });
});
