// Posts brand/social/schedule.json to X as each entry comes due, through a
// Chrome that is signed in as the account. Chrome is launched once with its
// own profile directory (brand/social/.chrome, sign in there the first time
// with --login) and stays open; the loop wakes every minute. Every post is
// marked in the schedule with its time or its error, so a restart resumes.
//
//   node brand/post.mjs --login      open Chrome on x.com and wait for you to sign in
//   node brand/post.mjs              run the schedule
//   node brand/post.mjs --once       post the next due entry and exit
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, "social");
const SCHEDULE = path.join(out, "schedule.json");
const PROFILE = path.join(out, ".chrome");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const args = process.argv.slice(2);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (s) => console.log(`[post ${new Date().toISOString().slice(11, 19)}] ${s}`);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !args.includes("--login"), userDataDir: PROFILE,
  defaultViewport: { width: 1400, height: 1000 },
  args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
});
const page = (await browser.pages())[0] || await browser.newPage();
await page.setUserAgent((await browser.userAgent()).replace(/Headless/i, ""));

// a first run takes the account's cookies from brand/social/.x-cookies.json
// (exported from a signed-in browser) so the profile needs no login
const COOKIES = path.join(out, ".x-cookies.json");
if (fs.existsSync(COOKIES)) {
  const cookies = JSON.parse(fs.readFileSync(COOKIES, "utf8")).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
  const cdp = await page.createCDPSession();
  await cdp.send("Network.setCookies", { cookies });
  await cdp.detach();
  fs.unlinkSync(COOKIES);
  log(`imported ${cookies.length} cookies`);
}
if (args.includes("--login")) {
  await page.goto("https://x.com/login");
  log("sign in to X in the window, then close it");
  await new Promise(r => browser.on("disconnected", r));
  process.exit(0);
}

async function signedIn() {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
  await sleep(5000);
  return !!(await page.$('[data-testid="SideNav_AccountSwitcher_Button"]'));
}

async function post(text, media) {
  await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30000 });
  await sleep(1500);
  await page.click('[data-testid="tweetTextarea_0"]');
  // paste, not type: the composer keeps line breaks and it is quick
  await page.evaluate((text) => {
    const el = document.querySelector('[data-testid="tweetTextarea_0"]');
    el.focus();
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await sleep(800);
  const typed = await page.evaluate(() => document.querySelector('[data-testid="tweetTextarea_0"]').innerText.length);
  if (typed < text.length * 0.9) throw new Error(`composer took ${typed} of ${text.length} characters`);
  const input = await page.$('input[data-testid="fileInput"]');
  await input.uploadFile(media);
  let attached = false;
  for (let k = 0; k < 40; k++) { await sleep(1000); if (await page.$('[data-testid="attachments"] img')) { attached = true; break; } }
  if (!attached) throw new Error("the image did not attach");
  await sleep(1500);
  const clicked = await page.evaluate(() => {
    // two composers can be mounted (the modal and the home inline one): the enabled one is ours
    const b = [...document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')].find(b => b.getAttribute("aria-disabled") !== "true");
    if (!b) return false; b.click(); return true;
  });
  if (!clicked) throw new Error("post button disabled");
  for (let k = 0; k < 20; k++) { await sleep(1000); if (await page.evaluate(() => document.body.innerText.includes("Your post was sent"))) return; }
  throw new Error("no confirmation that the post was sent");
}

if (!await signedIn()) { log("not signed in; run with --login first"); await browser.close(); process.exit(1); }
log("signed in");

for (;;) {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE, "utf8"));
  const due = schedule.find(p => !p.posted && p.at <= Date.now());
  const left = schedule.filter(p => !p.posted).length;
  if (!left) { log("schedule done"); break; }
  if (due) {
    try {
      await post(due.text, path.join(out, due.media));
      due.posted = new Date().toISOString();
      log(`posted ${due.media}: ${due.text.slice(0, 50)}… (${left - 1} left)`);
    } catch (e) {
      due.posted = "error: " + String(e.message).slice(0, 120);
      log(`FAILED ${due.media}: ${e.message}`);
      // an X hiccup is common; the next entry is tried on its own time
    }
    fs.writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 1) + "\n");
    if (args.includes("--once")) break;
  }
  await sleep(60_000);
}
await browser.close();
