export type PineDateStringResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

/** Parse the const timestamp(dateString) overload independently of the exchange timezone. */
export function parsePineDateString(text: string): PineDateStringResult {
  const source = text.trim();
  const namedOffset = /^(.*\S)\s+((?:UTC|GMT)(?:[+-]\d{1,2}(?::?\d{2})?)?)$/iu.exec(source);
  const explicitZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/u.test(source);
  const plain = namedOffset?.[1] ?? source;
  const calendarText = (namedOffset?.[1] ?? source.replace(/(?:[Zz]|[+-]\d{2}:?\d{2})$/u, "")).trimEnd();
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(calendarText);
  const namedCalendar = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/u.exec(calendarText);
  let fields: readonly [number, number, number, number, number, number];
  if (calendar !== null) {
    fields = [Number(calendar[1]), Number(calendar[2]), Number(calendar[3]),
      Number(calendar[4] ?? 0), Number(calendar[5] ?? 0), Number(calendar[6] ?? 0)];
  } else if (namedCalendar !== null) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(namedCalendar[2]?.slice(0, 3).toLowerCase() ?? "") + 1;
    fields = [Number(namedCalendar[3]), month, Number(namedCalendar[1]),
      Number(namedCalendar[4] ?? 0), Number(namedCalendar[5] ?? 0), Number(namedCalendar[6] ?? 0)];
  } else {
    return { ok: false, message: `Unsupported date string format: "${source}"` };
  }
  const [year, month, day, hour, minute, second] = fields;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year < 100) date.setUTCFullYear(year);
  if (month < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    return { ok: false, message: `Invalid date string: "${source}"` };
  }
  const isoLike = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/u.test(plain);
  const utcSource = isoLike ? `${plain.replace(" ", "T")}Z` : `${plain} UTC`;
  const parsed = namedOffset
    ? Date.parse(utcSource) - (timezoneOffsetMinutes(namedOffset[2] ?? "") ?? Number.NaN) * 60_000
    : Date.parse(explicitZone ? source : utcSource);
  if (!Number.isSafeInteger(parsed)) return { ok: false, message: `Invalid date string: "${source}"` };
  return { ok: true, value: parsed };
}

export function timezoneOffsetMinutes(timezone: string): number | undefined {
  if (timezone === "UTC" || timezone === "GMT" || timezone === "Etc/UTC") return 0;
  if (timezone === "UTC0" || timezone === "GMT0") return 0;
  const offset = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/iu.exec(timezone);
  if (offset === null) return undefined;
  const hours = Number.parseInt(offset[2] ?? "", 10);
  const minutes = Number.parseInt(offset[3] ?? "0", 10);
  if (minutes > 59) return undefined;
  const total = hours * 60 + minutes;
  const signed = offset[1] === "+" ? total : -total;
  return signed >= -12 * 60 && signed <= 14 * 60 ? signed : undefined;
}
