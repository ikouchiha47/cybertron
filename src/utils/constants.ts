// Detection thresholds
export const PERSON_DETECTION_THRESHOLD = 0.45;
// Minimum score for a detection to trigger capture/notification. Candidate
// boxes below this still render in the UI, but are side-effect free.
export const NOTIFY_MIN_SCORE = PERSON_DETECTION_THRESHOLD;
export const PERSON_CANDIDATE_MIN_SCORE = 0.25;
export const MAX_CANDIDATE_BADGES = 3;
export const EMPTY_FRAMES_BEFORE_RESET = 3;
export const NOTIFICATION_COOLDOWN_MS = 10000; // 10 seconds debounce between notifications

// Polling interval
export const DETECTION_INTERVAL_MS = 1000;

// Proximity thresholds (normalized bounding box height)
export const NEARNESS_VERY_CLOSE = 0.7;
export const NEARNESS_CLOSE = 0.4;
