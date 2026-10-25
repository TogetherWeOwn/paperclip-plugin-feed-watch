export const channel = 'UCLKPca3kwwd-B59HNr-_lvA';
export const video = 'DZ24Xbm9Joc';
export function atom(ids = [video], ch = channel) {
  return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">${ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${ch}</yt:channelId><title>Research &amp; testing</title><published>2026-10-25T10:00:00Z</published><updated>2026-10-25T11:00:00Z</updated></entry>`).join('')}</feed>`;
}

