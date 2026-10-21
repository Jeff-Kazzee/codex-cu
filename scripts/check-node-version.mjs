import { pathToFileURL } from 'node:url';

// Verified 2026-10-21:
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
// https://github.com/nodejs/Release/blob/main/schedule.json
const releaseLines = {
  22: { minimum: '22.23.4', end: '2027-04-30' },
  24: { minimum: '24.22.1', end: '2028-04-30' },
  26: { minimum: '26.12.1', end: '2029-04-30' },
};

export function nodeVersionError(version, date = new Date()) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    return `Node.js ${version} is not a stable version. Install a patched supported Node.js release.`;
  }

  const [major, minor, patch] = version.split('.').map(Number);
  const line = releaseLines[major];
  if (!line) {
    return `Node.js ${version} is unsupported by this policy. Install a supported Node.js release and update this policy.`;
  }
  if (date.toISOString().slice(0, 10) >= line.end) {
    return `Node.js ${major} reached end of life on ${line.end}. Update the CI/runtime version and this policy to a supported release line.`;
  }

  const [, minimumMinor, minimumPatch] = line.minimum.split('.').map(Number);
  if (minor < minimumMinor || (minor === minimumMinor && patch < minimumPatch)) {
    return `Node.js ${version} is below the required ${line.minimum} security release. Update the CI/runtime version and rerun this check.`;
  }
  return null;
}

export function assertNodeVersion() {
  const error = nodeVersionError(process.versions.node);
  if (error) throw new Error(error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const error = nodeVersionError(process.versions.node);
  if (error) {
    console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Node.js ${process.versions.node} passes the runtime security policy.`);
  }
}
