import { filterGesture, resetGestureFilter, SNAP_PEAK_THRESHOLD } from "../GestureFilter";

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

const SLOW = 1.5;               // deliberate turn peak (rad/s)
const SNAP = SNAP_PEAK_THRESHOLD + 0.1; // above threshold

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
  assert(filterGesture("turn_right", SLOW) === false, "turn_right at +100ms should be suppressed");
});

run("gesture after gobble window passes", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(501);
  assert(filterGesture("turn_right", SLOW) === true, "turn_right at +501ms should pass");
});

run("second shake during gobble window rearms window", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  tick(300);
  filterGesture("shake");
  tick(250);
  assert(filterGesture("turn_right", SLOW) === false, "should still be gobbled after re-arm");
  tick(260);
  assert(filterGesture("turn_left", SLOW) === true, "should pass after re-armed window expires");
});

run("snap-back cooldown suppresses opposite axis within 500ms", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right", SLOW);
  tick(100);
  assert(filterGesture("turn_left", SLOW) === false, "snap-back should suppress opposite axis");
  tick(450);
  assert(filterGesture("turn_left", SLOW) === true, "snap-back expired — should pass");
});

run("refractory suppresses identical gesture within 200ms", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right", SLOW);
  tick(41);
  assert(filterGesture("turn_right", SLOW) === false, "duplicate at 41ms should be suppressed");
  tick(80); // total 121ms
  assert(filterGesture("turn_right", SLOW) === false, "duplicate at 121ms still suppressed");
  tick(90); // total 211ms
  assert(filterGesture("turn_right", SLOW) === true, "at 211ms should pass");
});

run("refractory does not affect different gestures", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right", SLOW);
  tick(50);
  assert(filterGesture("pitch_down", SLOW) === true, "different gesture should not be blocked");
});

run("snap passes filter but does not arm snap-back cooldown", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right", SNAP);   // snap right — passes, no cooldown set
  tick(100);
  // turn_left should NOT be suppressed since snap didn't arm the cooldown
  assert(filterGesture("turn_left", SLOW) === true, "turn_left after snap should pass");
});

run("snap passes filter but does not arm refractory", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("turn_right", SNAP);
  tick(50);
  // same gesture again, slow this time — should NOT be suppressed by refractory
  assert(filterGesture("turn_right", SLOW) === true, "deliberate turn after snap should pass");
});

run("resetGestureFilter clears all state", () => {
  resetGestureFilter(); fakeNow = 1000;
  filterGesture("shake");
  filterGesture("turn_right", SLOW);
  tick(100);
  resetGestureFilter();
  // After reset: no cooldowns, no refractory. Fire turn_right, then turn_left
  // immediately — would normally be snap-back suppressed, but reset cleared it.
  // We verify reset cleared the shake gobble (turn_right passes) and that
  // a fresh turn_right + 501ms later turn_left also passes.
  assert(filterGesture("turn_right", SLOW) === true, "should pass after reset");
  tick(501); // past any snap-back from the turn_right above
  assert(filterGesture("turn_left", SLOW) === true, "opposite should pass after cooldown expires");
});

restore();
