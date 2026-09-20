/**
 * An outage that ran longer than this is a long repair saga (a transformer waiting on an insurance claim, a week of cable
 * work), not a "typical" restoration. It is still listed everywhere; it is only left out of the typical-time medians,
 * and the number left out is reported so the figure is honest about it.
 */
export const LONG_OUTAGE_HOURS = 72;
export const isLong = (hours) => hours != null && hours > LONG_OUTAGE_HOURS;
