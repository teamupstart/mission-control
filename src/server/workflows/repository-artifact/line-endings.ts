import type { CheckoutDirectories } from "./git.ts";
import { checkoutRecords, checkoutGit } from "./git.ts";
import { unavailable } from "./format.ts";

type CleanMode = "text" | "auto" | "raw";

/** Ask Git only for attributes. No content filter is selected or executed. */
export async function lineEndingModes(executable: string, directories: CheckoutDirectories, paths: string[], signal: AbortSignal) {
  const config = (type: string, key: string) => checkoutGit(executable, directories.root,
    ["config", "--includes", "--type=" + type, "-z", "--get", key], signal, true, directories);
  const setting = (await config("bool-or-str", "core.autocrlf")).toString().slice(0, -1).toLowerCase();
  const fallback: CleanMode = setting === "true" || setting === "input" ? "auto" : "raw";
  const overrides: Record<string, CleanMode> = {};
  if (!paths.length) return { fallback, overrides };
  const attrFile = await config("path", "core.attributesFile");
  if (!Buffer.from(attrFile.toString()).equals(attrFile)) unavailable();
  const args = attrFile.length ? ["-c", "core.attributesFile=" + attrFile.toString().slice(0, -1)] : [];
  const attributes = ["text", "crlf", "eol"];
  const values: string[] = [];
  let position = 0, field = 0;
  function* names() { for (const path of paths) yield Buffer.from(path + "00", "hex"); }
  await checkoutRecords(executable, directories, [...args, "check-attr", "-z", "--stdin", ...attributes], signal, 65536, record => {
    const key = paths[position] ?? unavailable();
    if (field === 0 && record.toString("hex") !== key) unavailable();
    if (field === 1 && record.toString() !== attributes[values.length]) unavailable();
    if (field === 2) values.push(record.toString());
    field = (field + 1) % 3;
    if (values.length !== attributes.length) return;
    // Git's convert_attrs calls git_path_check_crlf for text, then for legacy crlf.
    // Both attributes accept "auto" and "input".
    const text = values.slice(0, 2).find(value => ["set", "unset", "auto", "input"].includes(value));
    const mode = text === "unset" ? "raw" : text === "auto" ? "auto" :
      text || values[2] === "lf" || values[2] === "crlf" ? "text" : fallback;
    if (mode !== fallback) overrides[key] = mode;
    values.length = 0;
    position++;
  }, { input: names() });
  if (position !== paths.length || field || values.length) unavailable();
  return { fallback, overrides };
}

// Match Git's automatic text detection, including bare CR and a final DOS EOF.
export function autoText(data: Buffer) {
  let printable = 0, control = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0) return false;
    if (c === 13) { if (data[++i] !== 10) return false; }
    else if (c === 10) continue;
    else if (c === 127 || (c < 32 && c !== 8 && c !== 9 && c !== 12 && c !== 27)) control++;
    else printable++;
  }
  if (data.at(-1) === 26) control--;
  return control <= Math.floor(printable / 128);
}

export function cleanCrlf(bytes: Buffer) {
  const clean = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    clean[length++] = bytes[i]!;
  }
  return clean.subarray(0, length);
}
