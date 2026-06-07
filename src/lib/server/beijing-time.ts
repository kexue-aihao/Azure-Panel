const BEIJING_TIME_ZONE = 'Asia/Shanghai';

const beijingTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
	timeZone: BEIJING_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false
});

function toDate(value: Date | string | number) {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function beijingDateParts(date = new Date()) {
	return Object.fromEntries(
		beijingTimeFormatter.formatToParts(date).map((part) => [part.type, part.value])
	) as Record<Intl.DateTimeFormatPartTypes, string>;
}

export function formatBeijingDateTime(value: Date | string | number) {
	const date = toDate(value);
	if (!date) return String(value || '');
	const parts = beijingDateParts(date);
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function beijingFileTimestamp(date = new Date()) {
	const parts = beijingDateParts(date);
	return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}
