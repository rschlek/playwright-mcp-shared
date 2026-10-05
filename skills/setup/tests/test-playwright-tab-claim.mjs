import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: Playwright tab-claim helper test requires Windows; test_portable_lifecycle.py covers the portable helper.");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const claimScript = path.resolve(testsDir, "..", "scripts", "playwright-tab-claim.ps1");
const tempRoot = await mkdtemp(path.join(tmpdir(), "playwright-tab-claim-"));
const registry = path.join(tempRoot, "locks", "tab-claims.json");

function runClaim(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", claimScript, "-RuntimeRoot", tempRoot, ...args],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      let payload;
      try {
        payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      } catch {
        return reject(new Error(`Invalid claim output (${code}): ${stdout} ${stderr}`));
      }
      resolve({ code, payload });
    });
  });
}

function fail(message, value) {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

try {
  // Eight sessions claim at once: every claim lands, none is lost.
  const claims = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      runClaim(["-Action", "Claim", "-Owner", `test-client-${index}`, "-Task", `task ${index}`, "-Url", `http://127.0.0.1:9/tab-${index}?token=secret#frag`, "-TtlSeconds", "600"]),
    ),
  );
  if (!claims.every(({ code, payload }) => code === 0 && payload.claimed === true && /^[a-f0-9]{32}$/.test(payload.claim_id)))
    fail("Concurrent claims did not all succeed", claims);
  if (new Set(claims.map(({ payload }) => payload.claim_id)).size !== 8) fail("Claim IDs were not unique", claims);
  const listed = await runClaim(["-Action", "List"]);
  if (listed.code !== 0 || listed.payload.count !== 8) fail("Concurrent claims were lost", listed);
  const raw = await readFile(registry, "utf8");
  if (raw.includes("secret") || raw.includes("frag")) fail("The registry recorded a URL query or fragment", raw);
  if (JSON.stringify(listed.payload).includes(claims[0].payload.claim_id)) fail("List exposed claim IDs", listed);
  if (claims[0].payload.url !== "http://127.0.0.1:9/tab-0") fail("Claim URL was not reduced to scheme, host, and path", claims[0]);

  // Renew extends the expiry and may record the tab's new URL.
  const first = claims[0].payload;
  const renewed = await runClaim(["-Action", "Renew", "-ClaimId", first.claim_id, "-Url", "https://user:pw@example.com/next?x=1", "-TtlSeconds", "900"]);
  if (renewed.code !== 0 || renewed.payload.success !== true || renewed.payload.url !== "https://example.com/next") fail("Renew failed", renewed);
  if (Date.parse(renewed.payload.expires_utc) <= Date.parse(first.expires_utc)) fail("Renew did not extend the expiry", renewed);

  // A wrong claim ID changes nothing.
  const wrong = await runClaim(["-Action", "Release", "-ClaimId", "0".repeat(32)]);
  if (wrong.code !== 76 || wrong.payload.reason !== "claim-not-found-or-expired") fail("A wrong claim ID was accepted", wrong);

  const released = await runClaim(["-Action", "Release", "-ClaimId", first.claim_id]);
  if (released.code !== 0 || released.payload.success !== true) fail("Release failed", released);
  const releasedAgain = await runClaim(["-Action", "Release", "-ClaimId", first.claim_id]);
  if (releasedAgain.code !== 76) fail("A released claim was released twice", releasedAgain);

  // An expired entry drops off the list and is pruned on the next write.
  const state = JSON.parse(await readFile(registry, "utf8"));
  state.claims[0].expires_utc = new Date(Date.now() - 60_000).toISOString();
  const expiredId = state.claims[0].claim_id;
  await writeFile(registry, JSON.stringify(state));
  const afterExpiry = await runClaim(["-Action", "Status"]);
  if (afterExpiry.code !== 0 || afterExpiry.payload.count !== 6) fail("An expired claim was still listed", afterExpiry);
  const renewExpired = await runClaim(["-Action", "Renew", "-ClaimId", expiredId]);
  if (renewExpired.code !== 76) fail("An expired claim was renewed", renewExpired);
  if ((await readFile(registry, "utf8")).includes(expiredId)) fail("An expired claim was not pruned", expiredId);

  // Input validation.
  const invalid = [
    ["-Action", "Claim", "-Owner", "bad owner", "-Url", "https://example.com/"],
    ["-Action", "Claim", "-Owner", "ok", "-Url", "not a url"],
    ["-Action", "Claim", "-Owner", "ok"],
    ["-Action", "Claim", "-Owner", "ok", "-Url", "https://example.com/", "-Task", "x".repeat(121)],
    ["-Action", "Renew", "-ClaimId", "nope"],
  ];
  for (const args of invalid) {
    const result = await runClaim(args);
    if (result.code !== 70 || result.payload.reason !== "error") fail(`Invalid input was accepted (${args.join(" ")})`, result);
  }
  await writeFile(registry, "{not json");
  const corrupt = await runClaim(["-Action", "List"]);
  if (corrupt.code !== 70) fail("A corrupt registry was accepted", corrupt);

  console.log(
    "PASS: Eight concurrent tab claims all landed with unique IDs; renew, release, expiry pruning, URL redaction, and input validation behave as specified.",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
