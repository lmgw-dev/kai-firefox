// Uploads a signed build to this project's GitLab generic package registry (the builds channel,
// design §10) from a GitLab CI job: the XPI to its version's package, then the same XPI under the fixed
// name kai-firefox.xpi and updates.json to the `updates` package (updates.json is the file the XPI's
// update_url points at; the fixed name is the stable link to the newest build, for Kai's install button).
// usage: node scripts/publish-gitlab.mjs [target/sign/<version>]   (npm run publish:gitlab)
//   The folder is the one scripts/sign.mjs filled; without an argument the one folder under
//   target/sign/ that has an updates.json.
//
// - Refuses to run anywhere but GitLab CI: the credential is the job's CI_JOB_TOKEN, sent as the
//   JOB-TOKEN header, and the URLs are the job's own project's.
// - Checks first that the folder is what this job's channel would have produced: the XPI is the one
//   updates.json hashes, and its update_link is the URL the registry will serve it from.
// - Duplicates: the registry takes a file of the same name again as another file of that package,
//   and serves the newest. updates.json is uploaded under one name for every build, so the group
//   setting "Allow duplicates" for generic packages must be on (it is GitLab's default); a refusal
//   (403) says so.
// - updates.json is left alone when the registry's own names a higher version (two pipelines can
//   finish in the other order than they started), and the script says so. The fixed-name XPI follows
//   the same rule: it is uploaded only where updates.json is, so it never goes back to an older build.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ChannelError, FIXED_XPI_NAME, channelFor, compareVersions, gitlabRegistry, sha256, xpiName } from "./channel.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export class PublishError extends Error {}
const fail = (m) => {
  throw new PublishError(m);
};

// Reads a folder of scripts/sign.mjs and checks it against this job's channel.
export function readBuild(env, dir) {
  let channel;
  try {
    channel = channelFor(env, { release: false });
  } catch (e) {
    if (e instanceof ChannelError) fail(e.message);
    throw e;
  }
  const updatesPath = join(dir, "updates.json");
  if (!existsSync(updatesPath)) fail(`${updatesPath} does not exist; npm run sign writes it after AMO has signed the build`);
  const updatesBytes = readFileSync(updatesPath);
  let updates;
  try {
    updates = JSON.parse(updatesBytes.toString("utf8"));
  } catch (e) {
    fail(`${updatesPath} is not JSON: ${e.message}`);
  }
  const addons = Object.entries(updates?.addons ?? {});
  if (addons.length !== 1 || addons[0][1]?.updates?.length !== 1) fail(`${updatesPath} does not hold one add-on with one update entry`);
  const [, { updates: [entry] }] = addons[0];
  const version = entry.version;
  if (basename(resolve(dir)) !== version) fail(`${updatesPath} is for version ${version}, but the folder is ${basename(resolve(dir))}`);
  const xpiPath = join(dir, xpiName(version));
  if (!existsSync(xpiPath)) fail(`${xpiPath} does not exist`);
  const xpi = readFileSync(xpiPath);
  if (entry.update_hash !== `sha256:${sha256(xpi)}`) fail(`${xpiPath} is not the file updates.json hashes (update_hash differs)`);
  if (entry.update_link !== channel.xpiLink(version)) {
    fail(
      "updates.json's update_link is not this job's registry URL for the XPI (it was made by another channel or project, " +
        "or KAI_FIREFOX_UPDATE_TOKEN differs from the one the build used)",
    );
  }
  return { version, xpi, xpiPath, updatesBytes, updatesPath };
}

// Uploads dir's XPI, its copy under the fixed name and updates.json (dir: the one folder under target/sign/ with an updates.json when
// not given). `fetch` and `log` can be replaced (the unit tests do).
export async function publish({ env, dir, fetch = globalThis.fetch, log = console.log }) {
  if (env.GITLAB_CI !== "true") fail("this runs only in GitLab CI (GITLAB_CI is not true); a local build is not published anywhere");
  const jobToken = env.CI_JOB_TOKEN;
  if (!jobToken) fail("CI_JOB_TOKEN is not set");
  let registry;
  try {
    registry = gitlabRegistry(env);
  } catch (e) {
    if (e instanceof ChannelError) fail(e.message);
    throw e;
  }
  const build = readBuild(env, dir ?? findDir());
  const headers = { "JOB-TOKEN": jobToken, "User-Agent": "kai-firefox-publish" };

  async function put(url, bytes, what) {
    const r = await fetch(url, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: bytes });
    if (r.status === 200 || r.status === 201) return;
    const said = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const hint =
      r.status === 403
        ? ' If GitLab says anything about duplicates, turn "Allow duplicates" on for generic packages in the group\'s Settings > Packages and registries; ' +
          "otherwise the user who ran the pipeline needs the Developer role in the project."
        : r.status === 401
          ? " The job token was not accepted."
          : "";
    fail(`GitLab refused the upload of ${what}: ${r.status} ${said}.${hint}`);
  }

  log(`publish: ${build.version} to ${registry.xpiUrl(build.version)}`);
  await put(registry.xpiUrl(build.version), build.xpi, basename(build.xpiPath));
  log(`publish: uploaded ${basename(build.xpiPath)} (${build.xpi.length} bytes)`);

  // updates.json: not over a newer one.
  let newer = null;
  try {
    const r = await fetch(registry.updatesUrl, { headers });
    if (r.ok) {
      const body = await r.json();
      const seen = Object.values(body?.addons ?? {}).flatMap((a) => (a.updates ?? []).map((u) => u.version));
      newer = seen.find((v) => compareVersions(v, build.version) > 0) ?? null;
    } else if (r.status !== 404) {
      log(`publish: warning, could not read the registry's updates.json (${r.status}); uploading ours`);
    }
  } catch (e) {
    log(`publish: warning, could not read the registry's updates.json (${e.message}); uploading ours`);
  }
  if (newer) {
    log(`publish: the registry's updates.json already names ${newer}, newer than ${build.version}; it is left as it is`);
    return { version: build.version, updatesUploaded: false };
  }
  await put(registry.fixedXpiUrl, build.xpi, FIXED_XPI_NAME);
  log(`publish: uploaded ${FIXED_XPI_NAME} for ${build.version}`);
  await put(registry.updatesUrl, build.updatesBytes, "updates.json");
  log(`publish: uploaded updates.json for ${build.version}`);
  return { version: build.version, updatesUploaded: true };
}

function findDir() {
  const base = join(root, "target", "sign");
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => existsSync(join(base, d, "updates.json"))) : [];
  if (dirs.length !== 1) {
    fail(
      dirs.length
        ? `more than one folder under target/sign/ has an updates.json (${dirs.join(", ")}); name the one to publish`
        : "no folder under target/sign/ has an updates.json; run npm run sign first, or name the folder",
    );
  }
  return join(base, dirs[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await publish({ env: process.env, dir: process.argv[2] ? resolve(process.argv[2]) : undefined });
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    console.error(`publish-gitlab: ${e.message}`);
    process.exit(1);
  }
}
