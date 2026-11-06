import { execFile } from "node:child_process";

export type Exec = (ref: string) => Promise<string>;

const opRead: Exec = (ref) =>
  new Promise((resolve, reject) => {
    execFile("op", ["read", ref], { timeout: 30_000 }, (err, stdout) => {
      // Never include stderr or the reference output in the error.
      if (err) reject(new Error("Could not read the PAT with the 1Password CLI"));
      else resolve(stdout.trim());
    });
  });

/** Read the read-only PAT once at startup. Throws if it cannot be read. */
export async function readPat(ref: string, exec: Exec = opRead): Promise<string> {
  const pat = await exec(ref);
  if (!pat) throw new Error("The PAT item is empty");
  return pat;
}
