import { filterGesture, resetGestureFilter } from "../GestureFilter";

// ── helpers ───────────────────────────────────────────────────────────────────

let fakeNow = 1000;
const origDateNow = Date.now;
function install() { Date.now = () => fakeNow; }
function restore() { Date.now = origDateNow; }
function tick(ms: number) { fakeNow += ms; }

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e: unknown) {
    console.error(`  FAIL  ${label}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── tests ─────────────────────────────────────────────────────────────────────

install();
console.log("GestureFilter");

run("shake always passes", () => {
  resetGestureFilter(); fakeNow = 1000;
  assert(filterGesture("shake") === true, "shake should pass");
});

run("gesture immediately after shake is suppressed", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(100);
  assert(filterGesture("turn_right") === false, "turn_right at +100ms should be suppressed");
});

run("gesture after gobble window passes", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(501);
  assert(filterGesture("turn_right") === true, "turn_right at +501ms should pass");
});

run("second shake during gobble window rearms window", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(300);
  filterGesture("shake"); // rearms at 1300 → gobble until 1800
  tick(250);              // now at 1550 — still inside new window
  assert(filterGesture("turn_right") === false, "should still be gobbled after re-arm");
  tick(260);              // now at 1810 — past 1800
  assert(filterGesture("turn_left") === true, "should pass after re-armed window expires");
});

run("snap-back cooldown still works outside gobble window", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right"); // sets roll cooldown
  tick(100);
  assert(filterGesture("turn_left") === false, "snap-back should suppress opposite axis");
  tick(450); // total 550ms > 500ms cooldown
  assert(filterGesture("turn_left") === true, "snap-back expired — should pass");
});

run("resetGestureFilter clears gobble window", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(100);
  resetGestureFilter();
  assert(filterGesture("turn_right") === true, "should pass after reset");
});

restore();
