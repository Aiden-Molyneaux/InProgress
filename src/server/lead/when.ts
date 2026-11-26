import { stamp } from '../../core/span';

/** Local clock words shared by the morning list and the usage text. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** `09:30`, local. */
export const hhmm = (iso: string): string => stamp(iso).slice(11);
/** `Wednesday 09:00`, local. */
export const dayTime = (iso: string): string => `${WEEKDAYS[new Date(iso).getDay()]} ${hhmm(iso)}`;
