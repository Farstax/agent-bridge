import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const RELEASE_TAG = /^release-(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d*)$/;

function releaseIdentity(tag) {
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

  return { year, month, day, sequence };
}

export function releaseCompatibilityVersion(tag) {
  const { year, month, day, sequence } = releaseIdentity(tag);
  return `${year}.${month}.${day}-${sequence}`;
}

export function compareReleaseTags(leftTag, rightTag) {
  const left = releaseIdentity(leftTag);
  const right = releaseIdentity(rightTag);
  for (const key of ["year", "month", "day", "sequence"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function assertReleaseTagAfter(previousTag, candidateTag) {
  if (compareReleaseTags(candidateTag, previousTag) <= 0) {
    throw new Error(`release tag ${candidateTag} must be newer than latest published release ${previousTag}`);
  }
  return releaseCompatibilityVersion(candidateTag);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--assert-after") {
    if (args.length !== 3) {
      throw new Error("usage: releaseVersion.mjs --assert-after PREVIOUS_TAG CANDIDATE_TAG");
    }
    process.stdout.write(`${assertReleaseTagAfter(args[1], args[2])}\n`);
  } else {
    if (args.length !== 1) {
      throw new Error("usage: releaseVersion.mjs release-YYYY.MM.DD-N");
    }
    process.stdout.write(`${releaseCompatibilityVersion(args[0])}\n`);
  }
}
