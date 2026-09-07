import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const RELEASE_TAG = /^release-(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d*)$/;

export function releaseCompatibilityVersion(tag) {
  const match = RELEASE_TAG.exec(String(tag ?? ""));
  if (!match) {
    throw new Error("release tag must match release-YYYY.MM.DD-N with a positive sequence");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const sequence = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || !Number.isSafeInteger(sequence)
  ) {
    throw new Error(`release tag is not a valid canonical release identity: ${tag}`);
  }

  return `${year}.${month}.${day}-${sequence}`;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error("usage: releaseVersion.mjs release-YYYY.MM.DD-N");
  }
  process.stdout.write(`${releaseCompatibilityVersion(process.argv[2])}\n`);
}
