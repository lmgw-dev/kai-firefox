// The release channels (scripts/channel.mjs), the update manifest, the XPI reader (scripts/xpi.mjs)
// and the GitLab publish (scripts/publish-gitlab.mjs), in Node, offline: the publish talks to a
// fake fetch.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { ChannelError, FIXED_XPI_NAME, channelFor, compareVersions, gitlabRegistry, sha256, signedFileProblem, updatesJson, xpiName } from "../../scripts/channel.mjs";
import { PublishError, publish } from "../../scripts/publish-gitlab.mjs";
import { xpiManifest } from "../../scripts/xpi.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GITLAB = { GITLAB_CI: "true", CI_API_V4_URL: "https://git.example/api/v4", CI_PROJECT_ID: "42", CI_JOB_TOKEN: "job-token-value" };
const GITHUB = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "owner/kai-firefox", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.2.0" };
const REGISTRY = "https://git.example/api/v4/projects/42/packages/generic/kai-firefox";
const DEPLOY = "gitlab+deploy-token-7:s3cr3t-T0ken_x";
const ID = "kai-firefox@rootshell.dev";

// A scratch folder under target/ (gitignored; /tmp may be tmpfs).
function scratch() {
  mkdirSync(join(ROOT, "target"), { recursive: true });
  return mkdtempSync(join(ROOT, "target", "unit-release-"));
}

// A zip with the given entries (name -> string), each stored or deflated as listed.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, method] of entries) {
    const data = Buffer.from(text);
    const body = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(4, 28); // an extra field, as AMO's files have
    const extra = Buffer.from([0xfe, 0xca, 0x00, 0x00]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, extra, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + extra.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const throws = (fn, Class, pattern, secrets = []) => {
  let error;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof Class, `expected ${Class.name}, got ${error}`);
  assert.match(error.message, pattern);
  for (const s of secrets) assert.ok(!error.message.includes(s), `the message names a secret: ${error.message}`);
};

// A folder like scripts/sign.mjs leaves it, for the GitLab channel under `env`.
function build(env, version, { release = false } = {}) {
  const base = scratch();
  const dir = join(base, version);
  mkdirSync(dir);
  const xpiBytes = Buffer.from(`PK fake xpi ${version}`);
  writeFileSync(join(dir, xpiName(version)), xpiBytes);
  writeFileSync(join(dir, "updates.json"), JSON.stringify(updatesJson({ addonId: ID, version, updateLink: channelFor(env, { release }).xpiLink(version), xpi: xpiBytes })));
  return { base, dir, xpiBytes };
}

// A fetch that records its calls and answers from `answers` (method + URL -> status, body).
function fakeFetch(answers = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, headers: init.headers, body: init.body });
    const a = answers[`${method} ${url}`] ?? (method === "GET" ? { status: 404, body: "{}" } : { status: 201, body: '{"message":"201 Created"}' });
    return new Response(a.body, { status: a.status });
  };
  return { fetch, calls };
}

export default [
  {
    name: "release channel: a local run has no update URL and no link",
    fn() {
      const c = channelFor({});
      assert.equal(c.name, "local");
      assert.equal(c.updateUrl, null);
      assert.equal(c.xpiLink("0.1.0.5"), null);
      assert.match(c.shown, /^none/);
      // An unrelated CI variable, or "false", is not a CI.
      assert.equal(channelFor({ GITLAB_CI: "false", GITHUB_ACTIONS: "" }).name, "local");
    },
  },
  {
    name: "release channel: GitLab CI is the builds channel, URLs from CI_API_V4_URL and CI_PROJECT_ID",
    fn() {
      const c = channelFor(GITLAB);
      assert.equal(c.name, "builds");
      assert.equal(c.updateUrl, `${REGISTRY}/updates/updates.json`);
      assert.equal(c.xpiLink("0.1.0.47"), `${REGISTRY}/0.1.0.47/kai-firefox-0.1.0.47.xpi`);
      assert.match(c.shown, /no credential/);
      // A trailing slash and a subpath (GitLab under a prefix) are kept right.
      const g = gitlabRegistry({ ...GITLAB, CI_API_V4_URL: "https://host.example:8443/gl/api/v4/" });
      assert.equal(g.updatesUrl, "https://host.example:8443/gl/api/v4/projects/42/packages/generic/kai-firefox/updates/updates.json");
      assert.equal(g.xpiUrl("1.2.3.4"), "https://host.example:8443/gl/api/v4/projects/42/packages/generic/kai-firefox/1.2.3.4/kai-firefox-1.2.3.4.xpi");
      // The stable install URL: a name that never changes, in the package updates.json is in.
      assert.equal(FIXED_XPI_NAME, "kai-firefox.xpi");
      assert.equal(g.fixedXpiUrl, "https://host.example:8443/gl/api/v4/projects/42/packages/generic/kai-firefox/updates/kai-firefox.xpi");
      assert.equal(gitlabRegistry(GITLAB).fixedXpiUrl, `${REGISTRY}/updates/kai-firefox.xpi`);
    },
  },
  {
    name: "release channel: KAI_FIREFOX_UPDATE_TOKEN goes into both URLs as userinfo, and into no message",
    fn() {
      const c = channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: DEPLOY });
      const u = new URL(c.updateUrl);
      assert.equal(decodeURIComponent(u.username), "gitlab+deploy-token-7");
      assert.equal(decodeURIComponent(u.password), "s3cr3t-T0ken_x");
      assert.equal(c.updateUrl, "https://gitlab+deploy-token-7:s3cr3t-T0ken_x@git.example/api/v4/projects/42/packages/generic/kai-firefox/updates/updates.json");
      assert.equal(c.xpiLink("0.1.0.47"), "https://gitlab+deploy-token-7:s3cr3t-T0ken_x@git.example/api/v4/projects/42/packages/generic/kai-firefox/0.1.0.47/kai-firefox-0.1.0.47.xpi");
      assert.ok(!c.shown.includes("s3cr3t"), "the log line carries no credential");
      assert.match(c.shown, /with a read credential/);
      // Characters userinfo cannot hold are encoded, and the pieces still read back.
      const odd = channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: "user@x:p/w?#d" });
      const o = new URL(odd.updateUrl);
      assert.equal(o.host, "git.example");
      assert.equal(decodeURIComponent(o.username), "user@x");
      assert.equal(decodeURIComponent(o.password), "p/w?#d");
      // Not user:token: refused without the value in the message.
      for (const bad of ["onlyatoken1234", ":token", "user:", "us er:token"]) {
        throws(() => channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: bad }), ChannelError, /KAI_FIREFOX_UPDATE_TOKEN/, [bad]);
      }
      assert.equal(channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: "  " }).updateUrl, `${REGISTRY}/updates/updates.json`, "a blank token is none");
    },
  },
  {
    name: "release channel: GitLab needs its variables and https; the token is not read outside GitLab",
    fn() {
      throws(() => channelFor({ GITLAB_CI: "true" }), ChannelError, /CI_API_V4_URL or CI_PROJECT_ID/);
      throws(() => channelFor({ ...GITLAB, CI_PROJECT_ID: "not-a-number" }), ChannelError, /CI_PROJECT_ID/);
      throws(() => channelFor({ ...GITLAB, CI_API_V4_URL: "http://git.example/api/v4" }), ChannelError, /https/);
      throws(() => channelFor({ ...GITLAB, CI_API_V4_URL: "https://u:p@git.example/api/v4" }), ChannelError, /credential/);
      const local = channelFor({ KAI_FIREFOX_UPDATE_TOKEN: DEPLOY });
      assert.equal(local.updateUrl, null, "a desk with the token set still builds without an update URL");
      // The old free override is gone.
      assert.equal(channelFor({ KAI_FIREFOX_UPDATE_URL: "https://elsewhere.example/updates.json" }).updateUrl, null);
      assert.equal(channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_URL: "https://elsewhere.example/updates.json" }).updateUrl, `${REGISTRY}/updates/updates.json`);
    },
  },
  {
    name: "release channel: GitHub Actions with --release is the releases channel",
    fn() {
      const c = channelFor(GITHUB, { release: true });
      assert.equal(c.name, "releases");
      assert.equal(c.updateUrl, "https://github.com/owner/kai-firefox/releases/latest/download/updates.json");
      assert.equal(c.xpiLink("0.2.0.0"), "https://github.com/owner/kai-firefox/releases/download/v0.2.0/kai-firefox-0.2.0.0.xpi");
      assert.equal(c.shown, c.updateUrl);
      // The GitLab token means nothing here.
      assert.equal(channelFor({ ...GITHUB, KAI_FIREFOX_UPDATE_TOKEN: DEPLOY }, { release: true }).updateUrl, c.updateUrl);
      throws(() => channelFor({ ...GITHUB, GITHUB_REPOSITORY: "no-slash" }, { release: true }), ChannelError, /GITHUB_REPOSITORY/);
      throws(() => channelFor({ ...GITHUB, GITHUB_REF_TYPE: "branch" }, { release: true }), ChannelError, /tag/);
    },
  },
  {
    name: "release channel: --release without GitHub Actions, GitHub Actions without --release and two CIs are refused",
    fn() {
      throws(() => channelFor({}, { release: true }), ChannelError, /--release is for the GitHub Actions/);
      throws(() => channelFor(GITLAB, { release: true }), ChannelError, /--release is for the GitHub Actions/);
      throws(() => channelFor(GITHUB, { release: false }), ChannelError, /only a release is signed/);
      throws(() => channelFor({ ...GITLAB, ...GITHUB }, { release: true }), ChannelError, /both/);
    },
  },
  {
    name: "release channel: updates.json holds the one entry with the XPI's sha256 and the link",
    fn() {
      const xpi = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 250, 251]);
      const u = updatesJson({ addonId: ID, version: "0.1.0.47", updateLink: "https://x.example/a.xpi", xpi });
      assert.deepEqual(u, {
        addons: { [ID]: { updates: [{ version: "0.1.0.47", update_link: "https://x.example/a.xpi", update_hash: `sha256:${sha256(xpi)}` }] } },
      });
      assert.match(u.addons[ID].updates[0].update_hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(sha256(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      assert.notEqual(updatesJson({ addonId: ID, version: "1", updateLink: "l", xpi: Buffer.from("other") }).addons[ID].updates[0].update_hash, u.addons[ID].updates[0].update_hash);
    },
  },
  {
    name: "release channel: versions compare as numbers, not text",
    fn() {
      assert.ok(compareVersions("0.1.0.100", "0.1.0.47") > 0);
      assert.ok(compareVersions("0.1.0.9", "0.1.0.47") < 0);
      assert.ok(compareVersions("0.2.0.0", "0.1.0.999") > 0);
      assert.equal(compareVersions("0.1.0", "0.1.0.0"), 0);
    },
  },
  {
    name: "release channel: manifest.json is read out of an XPI, stored or deflated, among other entries",
    fn() {
      const manifest = JSON.stringify({ version: "0.1.0.47", browser_specific_settings: { gecko: { update_url: "https://x.example/u.json" } } });
      for (const method of [0, 8]) {
        const x = zip([["META-INF/mozilla.rsa", "sig", 0], ["extension.js", "x".repeat(500), 8], ["manifest.json", manifest, method]]);
        assert.deepEqual(xpiManifest(x), JSON.parse(manifest), `method ${method}`);
      }
      assert.throws(() => xpiManifest(zip([["a.js", "x", 0]])), /no manifest\.json/);
      assert.throws(() => xpiManifest(Buffer.from("not a zip at all, long enough to look through for a record")), /not a zip/);
    },
  },
  {
    name: "release channel: a signed file is taken only when its version and update_url are the run's",
    fn() {
      const token = channelFor({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: DEPLOY });
      const builds = channelFor(GITLAB);
      const local = channelFor({});
      const manifest = (version, update_url) => ({ version, browser_specific_settings: { gecko: { id: ID, ...(update_url ? { update_url } : {}) } } });
      assert.equal(signedFileProblem(manifest("0.1.0.47", builds.updateUrl), { version: "0.1.0.47", channel: builds }), null);
      assert.equal(signedFileProblem(manifest("0.1.0.47", token.updateUrl), { version: "0.1.0.47", channel: token }), null);
      assert.equal(signedFileProblem(manifest("0.1.0.47"), { version: "0.1.0.47", channel: local }), null);
      // A local signing of the same commit, then CI.
      assert.match(signedFileProblem(manifest("0.1.0.47"), { version: "0.1.0.47", channel: builds }), /carries no update URL, but the builds channel wants its own/);
      // A CI build, then a local run.
      assert.match(signedFileProblem(manifest("0.1.0.47", builds.updateUrl), { version: "0.1.0.47", channel: local }), /carries an update URL, but the local channel wants none/);
      // The same project with another token, and another version.
      const p = signedFileProblem(manifest("0.1.0.47", builds.updateUrl), { version: "0.1.0.47", channel: token });
      assert.match(p, /carries an update URL/);
      assert.ok(!p.includes("s3cr3t") && !p.includes("deploy-token"), "the message holds no URL");
      assert.match(signedFileProblem(manifest("0.1.0.46", builds.updateUrl), { version: "0.1.0.47", channel: builds }), /version 0\.1\.0\.46, not 0\.1\.0\.47/);
    },
  },
  {
    name: "publish: refuses outside GitLab CI, before it reads or sends anything",
    async fn() {
      const { fetch, calls } = fakeFetch();
      for (const env of [{}, { ...GITLAB, GITLAB_CI: "false" }, GITHUB, { CI_JOB_TOKEN: "job-token-value" }]) {
        await assert.rejects(publish({ env, dir: "/does/not/exist", fetch, log() {} }), (e) => e instanceof PublishError && /only in GitLab CI/.test(e.message));
      }
      await assert.rejects(publish({ env: { ...GITLAB, CI_JOB_TOKEN: "" }, dir: "/does/not/exist", fetch, log() {} }), /CI_JOB_TOKEN/);
      assert.equal(calls.length, 0);
    },
  },
  {
    name: "publish: the XPI goes to its version's package, then under the fixed name and updates.json to the updates package, with the job token",
    async fn() {
      const env = { ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: DEPLOY };
      const { base, dir, xpiBytes } = build(env, "0.1.0.47");
      try {
        const { fetch, calls } = fakeFetch();
        const logged = [];
        const r = await publish({ env, dir, fetch, log: (m) => logged.push(m) });
        assert.deepEqual(r, { version: "0.1.0.47", updatesUploaded: true });
        assert.deepEqual(
          calls.map((c) => `${c.method} ${c.url}`),
          [
            `PUT ${REGISTRY}/0.1.0.47/kai-firefox-0.1.0.47.xpi`,
            `GET ${REGISTRY}/updates/updates.json`,
            `PUT ${REGISTRY}/updates/kai-firefox.xpi`,
            `PUT ${REGISTRY}/updates/updates.json`,
          ],
        );
        for (const c of calls) assert.equal(c.headers["JOB-TOKEN"], "job-token-value");
        assert.deepEqual(Buffer.from(calls[0].body), xpiBytes);
        assert.deepEqual(Buffer.from(calls[2].body), xpiBytes, "the fixed name holds the same bytes");
        const sent = JSON.parse(Buffer.from(calls[3].body).toString());
        assert.equal(sent.addons[ID].updates[0].update_link, `https://${DEPLOY}@git.example/api/v4/projects/42/packages/generic/kai-firefox/0.1.0.47/kai-firefox-0.1.0.47.xpi`);
        assert.ok(!logged.join("\n").includes("s3cr3t"), "the log carries no credential");
        assert.ok(!logged.join("\n").includes("job-token-value"));
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "publish: updates.json and the fixed-name XPI are left alone when the registry's updates.json names a newer version, replaced when older",
    async fn() {
      const { base, dir } = build(GITLAB, "0.1.0.47");
      try {
        const newer = { status: 200, body: JSON.stringify({ addons: { [ID]: { updates: [{ version: "0.1.0.100" }] } } }) };
        const a = fakeFetch({ [`GET ${REGISTRY}/updates/updates.json`]: newer });
        const logged = [];
        assert.deepEqual(await publish({ env: GITLAB, dir, fetch: a.fetch, log: (m) => logged.push(m) }), { version: "0.1.0.47", updatesUploaded: false });
        assert.deepEqual(a.calls.map((c) => `${c.method} ${c.url}`), [`PUT ${REGISTRY}/0.1.0.47/kai-firefox-0.1.0.47.xpi`, `GET ${REGISTRY}/updates/updates.json`], "the versioned XPI is uploaded; the fixed name and updates.json are not");
        assert.match(logged.join("\n"), /already names 0\.1\.0\.100/);
        const older = { status: 200, body: JSON.stringify({ addons: { [ID]: { updates: [{ version: "0.1.0.9" }] } } }) };
        const b = fakeFetch({ [`GET ${REGISTRY}/updates/updates.json`]: older });
        assert.equal((await publish({ env: GITLAB, dir, fetch: b.fetch, log() {} })).updatesUploaded, true);
        assert.deepEqual(b.calls.map((c) => c.method), ["PUT", "GET", "PUT", "PUT"]);
        assert.deepEqual(b.calls.slice(2).map((c) => c.url), [`${REGISTRY}/updates/kai-firefox.xpi`, `${REGISTRY}/updates/updates.json`]);
        // The same version again (a re-run) is not newer: both are uploaded again.
        const same = fakeFetch({ [`GET ${REGISTRY}/updates/updates.json`]: { status: 200, body: JSON.stringify({ addons: { [ID]: { updates: [{ version: "0.1.0.47" }] } } }) } });
        assert.equal((await publish({ env: GITLAB, dir, fetch: same.fetch, log() {} })).updatesUploaded, true);
        assert.deepEqual(same.calls.map((c) => c.method), ["PUT", "GET", "PUT", "PUT"]);
        // A registry that cannot be read does not stop the upload, and says so.
        const c = fakeFetch({ [`GET ${REGISTRY}/updates/updates.json`]: { status: 500, body: "" } });
        const said = [];
        assert.equal((await publish({ env: GITLAB, dir, fetch: c.fetch, log: (m) => said.push(m) })).updatesUploaded, true);
        assert.deepEqual(c.calls.map((x) => x.method), ["PUT", "GET", "PUT", "PUT"]);
        assert.match(said.join("\n"), /warning, could not read the registry's updates\.json \(500\)/);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "publish: a refusal by GitLab is the error, with the duplicates setting named for a 403",
    async fn() {
      const { base, dir } = build(GITLAB, "0.1.0.47");
      try {
        const xpi = `PUT ${REGISTRY}/0.1.0.47/kai-firefox-0.1.0.47.xpi`;
        const forbidden = fakeFetch({ [xpi]: { status: 403, body: '{"message":"403 Forbidden - Duplicate package is not allowed"}' } });
        await assert.rejects(publish({ env: GITLAB, dir, fetch: forbidden.fetch, log() {} }), (e) => e instanceof PublishError && /403/.test(e.message) && /Duplicate package/.test(e.message) && /Allow duplicates/.test(e.message));
        assert.equal(forbidden.calls.length, 1, "nothing is sent after a refusal");
        const down = fakeFetch({ [`PUT ${REGISTRY}/updates/updates.json`]: { status: 500, body: "boom" } });
        await assert.rejects(publish({ env: GITLAB, dir, fetch: down.fetch, log() {} }), /updates\.json: 500 boom/);
        const fixedDown = fakeFetch({ [`PUT ${REGISTRY}/updates/kai-firefox.xpi`]: { status: 500, body: "boom" } });
        await assert.rejects(publish({ env: GITLAB, dir, fetch: fixedDown.fetch, log() {} }), /kai-firefox\.xpi: 500 boom/);
        assert.ok(!fixedDown.calls.some((c) => c.url.endsWith("/updates.json") && c.method === "PUT"), "updates.json is not written when the fixed-name copy failed");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: "publish: a folder another channel, project or token made, or a changed XPI, is refused before anything is sent",
    async fn() {
      const { fetch, calls } = fakeFetch();
      const folders = [
        ["the releases channel's folder", () => build(GITHUB, "0.1.0.47", { release: true }), /update_link is not this job's registry URL/],
        ["another project's folder", () => build({ ...GITLAB, CI_PROJECT_ID: "7" }, "0.1.0.47"), /update_link is not this job's registry URL/],
        ["a folder made with another token", () => build({ ...GITLAB, KAI_FIREFOX_UPDATE_TOKEN: DEPLOY }, "0.1.0.47"), /KAI_FIREFOX_UPDATE_TOKEN differs/],
        [
          "an XPI that changed",
          () => {
            const b = build(GITLAB, "0.1.0.47");
            writeFileSync(join(b.dir, "kai-firefox-0.1.0.47.xpi"), "changed");
            return b;
          },
          /update_hash differs/,
        ],
        [
          "a local build, which has no updates.json",
          () => {
            const base = scratch();
            mkdirSync(join(base, "0.1.0.47"));
            return { base, dir: join(base, "0.1.0.47") };
          },
          /updates\.json does not exist/,
        ],
      ];
      for (const [what, make, error] of folders) {
        const b = make();
        try {
          await assert.rejects(publish({ env: GITLAB, dir: b.dir, fetch, log() {} }), (e) => e instanceof PublishError && error.test(e.message), what);
        } finally {
          rmSync(b.base, { recursive: true, force: true });
        }
      }
      assert.equal(calls.length, 0);
    },
  },
];
