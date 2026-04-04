// Detection thresholds
export const PERSON_DETECTION_THRESHOLD = 0.45;
export const PERSON_CANDIDATE_MIN_SCORE = 0.25;
export const MAX_CANDIDATE_BADGES = 3;
export const EMPTY_FRAMES_BEFORE_RESET = 3;
export const NOTIFICATION_COOLDOWN_MS = 120000; // 2 minutes

// Polling interval
export const DETECTION_INTERVAL_MS = 1000;

// Proximity thresholds (normalized bounding box height)
export const NEARNESS_VERY_CLOSE = 0.7;
export const NEARNESS_CLOSE = 0.4;
