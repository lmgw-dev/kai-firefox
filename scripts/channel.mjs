// Which update channel a signed build belongs to, and the URLs that follow from it (design §10).
// The channel comes from the environment alone, so no one can point a build at an arbitrary host:
//
//   GITLAB_CI=true                 the builds channel: updates from this project's GitLab package registry
//   GITHUB_ACTIONS=true + --release  the releases channel: updates from the GitHub repository's latest release
//   anything else                  a local build: no update URL, so Firefox never updates it
//
// Pure functions, no I/O: scripts/sign.mjs and scripts/publish-gitlab.mjs use them and
// tests/unit/release.test.mjs tests them.
import { createHash } from "node:crypto";

export const GITLAB_PACKAGE = "kai-firefox";
export const xpiName = (version) => `kai-firefox-${version}.xpi`;
// The same signed XPI under a name that never changes, so a link to "the newest build" (the install
// button in Kai's settings) stays one URL: next to updates.json in the builds channel, and as a release
// asset in the releases channel (releases/latest/download/kai-firefox.xpi).
export const FIXED_XPI_NAME = "kai-firefox.xpi";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class ChannelError extends Error {}
const fail = (m) => {
  throw new ChannelError(m);
};

// The GitLab package registry of this project, without any credential:
//   <api>/projects/<id>/packages/generic/kai-firefox/updates/updates.json   (the one updates.json)
//   <api>/projects/<id>/packages/generic/kai-firefox/updates/kai-firefox.xpi   (the newest XPI, a fixed name)
//   <api>/projects/<id>/packages/generic/kai-firefox/<version>/kai-firefox-<version>.xpi
export function gitlabRegistry(env) {
  const api = env.CI_API_V4_URL;
  const id = env.CI_PROJECT_ID;
  if (!api || !id) fail("GITLAB_CI is set but CI_API_V4_URL or CI_PROJECT_ID is not; this is not a GitLab CI job");
  if (!/^[0-9]+$/.test(id)) fail(`CI_PROJECT_ID is not a number: ${JSON.stringify(id)}`);
  let url;
  try {
    url = new URL(api);
  } catch {
    fail(`CI_API_V4_URL is not a URL: ${JSON.stringify(api)}`);
  }
  // Firefox takes an update_url over https only.
  if (url.protocol !== "https:") fail(`CI_API_V4_URL is not https (${url.protocol}); Firefox only follows https update URLs`);
  if (url.username || url.password || url.search || url.hash) fail("CI_API_V4_URL has a credential, query or fragment in it");
  const root = `${url.origin}${url.pathname.replace(/\/+$/, "")}/projects/${id}/packages/generic/${GITLAB_PACKAGE}`;
  return {
    updatesUrl: `${root}/updates/updates.json`,
    fixedXpiUrl: `${root}/updates/${FIXED_XPI_NAME}`,
    xpiUrl: (version) => `${root}/${version}/${xpiName(version)}`,
  };
}

// KAI_FIREFOX_UPDATE_TOKEN: "<deploy token user>:<deploy token>", a deploy token with read_package_registry.
// The message never contains the value.
function credentialOf(raw) {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const at = value.indexOf(":");
  if (at < 1 || at === value.length - 1 || /\s/.test(value)) fail('KAI_FIREFOX_UPDATE_TOKEN is not "<deploy token user>:<deploy token>"');
  return { user: value.slice(0, at), token: value.slice(at + 1) };
}
function withCredential(url, cred) {
  if (!cred) return url;
  const u = new URL(url);
  u.username = cred.user; // the URL setters percent-encode what userinfo cannot hold
  u.password = cred.token;
  return u.href;
}

// The channel of this run.
//   env      process.env as the process started (not a .env: a CI flag must be a real one)
//   release  whether --release was given
// -> { name, updateUrl, xpiLink(version), shown }
//   updateUrl  what goes into the XPI's gecko.update_url (null for a local build); may hold a credential
//   xpiLink    the update_link of that version's updates.json entry; may hold the same credential
//   shown      the update URL without its credential, for logs
export function channelFor(env, { release = false } = {}) {
  const gitlab = env.GITLAB_CI === "true";
  const github = env.GITHUB_ACTIONS === "true";
  if (gitlab && github) fail("both GITLAB_CI and GITHUB_ACTIONS are true; a build belongs to one CI");
  if (release && !github) {
    fail("--release is for the GitHub Actions release workflow (the releases channel). Local and GitLab builds are builds: leave --release out");
  }
  if (github && !release) {
    fail("under GitHub Actions only a release is signed (the releases channel); add --release. Builds belong to GitLab CI");
  }

  if (github) {
    const repo = env.GITHUB_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) fail(`GITHUB_REPOSITORY is not owner/name: ${JSON.stringify(repo)}`);
    // The release workflow runs on a pushed v<X.Y.Z> tag (or by hand with the tag as its ref).
    if (env.GITHUB_REF_TYPE !== "tag" || !env.GITHUB_REF_NAME) {
      fail(`the release workflow runs on the release's tag (GITHUB_REF_TYPE is ${JSON.stringify(env.GITHUB_REF_TYPE)}, not "tag")`);
    }
    const updateUrl = `https://github.com/${repo}/releases/latest/download/updates.json`;
    return {
      name: "releases",
      updateUrl,
      xpiLink: (version) => `https://github.com/${repo}/releases/download/${encodeURIComponent(env.GITHUB_REF_NAME)}/${xpiName(version)}`,
      shown: updateUrl,
    };
  }

  if (gitlab) {
    const registry = gitlabRegistry(env);
    const cred = credentialOf(env.KAI_FIREFOX_UPDATE_TOKEN);
    return {
      name: "builds",
      updateUrl: withCredential(registry.updatesUrl, cred),
      xpiLink: (version) => withCredential(registry.xpiUrl(version), cred),
      shown: `${registry.updatesUrl}${cred ? " (with a read credential in it)" : " (no credential: the project's package registry must allow anyone to pull)"}`,
    };
  }

  return { name: "local", updateUrl: null, xpiLink: () => null, shown: "none (a local build carries no update URL, so Firefox never updates it)" };
}

// Why the manifest of a file AMO signed is not what this run meant to sign (null when it is). AMO signs
// a version once, so a file an earlier run of the same version made (a local one, another channel's,
// one with another token) comes back as this run's; an update_url that is missing or different would
// sit in an XPI that never updates, silently. The message never holds the URL (it can hold a credential).
export function signedFileProblem(manifest, { version, channel }) {
  if (manifest?.version !== version) return `it is version ${manifest?.version}, not ${version}`;
  const carried = manifest.browser_specific_settings?.gecko?.update_url ?? null;
  if (carried === channel.updateUrl) return null;
  return `it ${carried ? "carries an update URL" : "carries no update URL"}, but the ${channel.name} channel wants ${channel.updateUrl ? "its own" : "none"}`;
}

// Firefox's update manifest for one signed XPI: a single entry, the newest (Firefox takes the highest version).
export function updatesJson({ addonId, version, updateLink, xpi }) {
  return {
    addons: { [addonId]: { updates: [{ version, update_link: updateLink, update_hash: `sha256:${sha256(xpi)}` }] } },
  };
}

// Dotted numeric versions: negative, 0 or positive like a - b.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
