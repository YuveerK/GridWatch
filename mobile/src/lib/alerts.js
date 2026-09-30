/** Quiet hours and alert wording that match what the server actually does. */

export const ALERT_COPY = {
  checking: 'Checking whether this phone can receive alerts.',
  enabled: 'Alerts are on for power and water in followed suburbs.',
  denied: 'Notification permission is off. Turn it on in system settings. Followed suburbs stay saved on this phone.',
  unavailable: 'Alerts are not being sent yet. Followed suburbs stay saved on this phone.',
  failed: 'Alert registration did not succeed. Followed suburbs stay saved on this phone.',
  off: 'Alerts are off. Followed suburbs stay saved on this phone.',
};

export const QUIET_COPY = 'Notifications are paused during these hours. Missed notifications are not sent later.';

/**
 * Whole hours only. Equal hours are not a window: the server treats them as quiet hours off.
 * @param {number | null} from
 * @param {number | null} to
 */
export function normalizeQuiet(from, to) {
  if (from == null || to == null) return { from: null, to: null, clearedBecauseEqual: false };
  if (from === to) return { from: null, to: null, clearedBecauseEqual: true };
  return { from, to, clearedBecauseEqual: false };
}
